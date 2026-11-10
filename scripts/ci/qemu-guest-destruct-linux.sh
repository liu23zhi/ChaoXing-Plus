#!/usr/bin/env bash
# QEMU 客机「关机销毁 / 开机续删」端到端驱动（Linux cloud image 版）。
#
# 为什么是 Linux 客机而不是 Windows 客机：
#   托管 runner 上没有 Windows qcow2（几 GB、需预装 OpenSSH Server 与 purge-tests.exe），
#   而 Linux cloud image 只要 ~260 MB 且能从公开 URL 拿到，cloud-init 可自动注入
#   SSH key —— 于是「QEMU 能不能在托管 runner 上真的引导 guest、guest 能不能真的
#   重启、重启后能不能真的执行续删」这套机制每次 CI 都能真跑一遍。
#
#   它验证什么（每条都是硬断言，不是自述）：
#     1. guest 真的引导起来了（SSH 回连成功）
#     2. guest 真的跑在 KVM 上（clock source == kvm-clock；TCG 下不可能是它）
#     3. guest 内登记了「待删目标」+「开机续删单元」（systemd oneshot）
#     4. guest 真的重启了 —— 用 kernel boot_id 前后比对，**不是看时间戳**
#     5. 重启后续删单元真的自己跑了 —— resume-proof 里的 boot_id == 当前 boot_id
#     6. 待删目标真的被删了
#     7. 续删单元真的自撤销了（unit 文件不存在、不再 enabled）
#
#   它不验证什么（必须如实标注，别把这里当成 Windows RunOnce 已覆盖）：
#     · HKCU\...\RunOnce 的登记与撤销 —— 那是 Windows 专属，由 ci.yml 里
#       qemu-shutdown-destruct 的 Windows 客机链路覆盖，需 repo variable
#       CX_QEMU_GUEST_IMAGE。
#     · Windows 的 WM_QUERYENDSESSION / WM_ENDSESSION 时序。
#     · MOVEFILE_DELAY_UNTIL_REBOOT 重启后消失。
#
# 用法（由 .github/workflows/ci.yml 的 qemu-destruct-linux-guest 作业分步调用）：
#   qemu-guest-destruct-linux.sh --phase prepare    # 下镜像 / 转格式 / 覆盖层 / SSH key / seed.iso
#   qemu-guest-destruct-linux.sh --phase boot       # 起 QEMU（-daemonize）并等 SSH 回连
#   qemu-guest-destruct-linux.sh --phase register   # guest 内登记待删目标 + 续删单元
#   qemu-guest-destruct-linux.sh --phase reboot     # guest 内重启并等回连
#   qemu-guest-destruct-linux.sh --phase replay     # 断言「重启过 + 已续删 + 已撤销」
#   qemu-guest-destruct-linux.sh --phase teardown   # 杀 QEMU、清临时私钥（不判红）
#
# ⚠️ 跨 step 的关键设计：QEMU 必须用 `-daemonize` 而不是 `&`。
#   每个 workflow step 是独立 shell，用 `&` 起的子进程在 step 结束时可能被回收，
#   下一个 step 就找不到客机了。`-daemonize` 让 QEMU 自己脱离会话并写 pidfile，
#   于是 boot / register / reboot / replay 可以安全地分在 4 个 step 里。
#   代价：QEMU 的 stdout 不再进日志，所以「KVM 是否真的生效」改由 guest 内的
#   clock source 断言，而不是 grep 宿主上的 QEMU 日志。
#
# 退出码：0 = 该阶段成立；非 0 = 该阶段断言失败（workflow 会因此判红）。

set -euo pipefail

PHASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,48p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$PHASE" ]; then echo '缺少 --phase' >&2; exit 2; fi

# 先校验 phase 取值再校验环境：参数错误应当永远 exit 2（用法错误），
# 不能被「RUNNER_TEMP 未设置」这种环境错误抢先成 exit 1，否则排障时会被误导。
case "$PHASE" in
  prepare|boot|register|reboot|replay|teardown) ;;
  *) echo "未知 phase: $PHASE" >&2; exit 2 ;;
esac

if [ -z "${RUNNER_TEMP:-}" ]; then echo 'RUNNER_TEMP 未设置（本脚本假定运行在 GitHub Actions runner 上）' >&2; exit 2; fi
WORK="$RUNNER_TEMP/cx-linux-guest"
IMG_URL="${CX_LINUX_GUEST_IMAGE:-https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img}"
SSH_PORT="${CX_LINUX_GUEST_SSH_PORT:-2223}"
BOOT_TIMEOUT="${CX_LINUX_GUEST_BOOT_TIMEOUT_SEC:-420}"
GUEST_USER="${CX_LINUX_GUEST_SSH_USER:-ubuntu}"

KEY="$WORK/id_ed25519"
PUB="$WORK/id_ed25519.pub"
BASE="$WORK/guest-base.qcow2"
OVERLAY="$WORK/guest-overlay.qcow2"
SEED="$WORK/seed.iso"
PIDFILE="$WORK/qemu.pid"

# guest 内的固定路径（register 写、replay 读，必须是同一组常量）
G_DIR=/var/lib/cx-destruct
G_TARGET="$G_DIR/target.txt"
G_BOOT_BEFORE="$G_DIR/boot-before.txt"
G_PROOF="$G_DIR/resume-proof.txt"
G_UNIT=/etc/systemd/system/cx-destruct-resume.service

say() { echo "[cx-linux-guest] $*"; }

ssh_guest() {
  ssh -i "$KEY" -p "$SSH_PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=15 -o BatchMode=yes -o LogLevel=ERROR \
      -o PreferredAuthentications=publickey \
      "${GUEST_USER}@127.0.0.1" "$@"
}

scp_to_guest() {
  scp -i "$KEY" -P "$SSH_PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=15 -o LogLevel=ERROR \
      "$1" "${GUEST_USER}@127.0.0.1:$2"
}

port_open() {
  # `set -e` 下这个函数会被用在 `if port_open` / `port_open && ...` 里，
  # 所以失败必须安静返回 1，不能把整个脚本带崩。
  if (exec 3<>"/dev/tcp/127.0.0.1/${SSH_PORT}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    return 0
  fi
  return 1
}

qemu_alive() {
  # 同上：失败路径只返回 1，`set -e` 不会在这里终止脚本。
  if [ ! -f "$PIDFILE" ]; then return 1; fi
  local pid
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -z "${pid:-}" ]; then return 1; fi
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  return 1
}

wait_ssh() {
  local label="$1" deadline=$(( $(date +%s) + BOOT_TIMEOUT )) ready=no
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! qemu_alive; then say "QEMU 进程已退出（$label）"; break; fi
    if port_open && ssh_guest true 2>/dev/null; then ready=yes; break; fi
    sleep 5
  done
  if [ "$ready" != yes ]; then
    say "SSH 未在 ${BOOT_TIMEOUT}s 内就绪（$label）"
    say "端口是否通: $(port_open && echo yes || echo no)"
    say "QEMU 是否存活: $(qemu_alive && echo yes || echo no)"
    return 1
  fi
  say "SSH 就绪（$label）"
}

case "$PHASE" in
# ─────────────────────────────────────────────────────────────────────────────
prepare)
  mkdir -p "$WORK"
  say "镜像源: $IMG_URL"

  if [ -f "$BASE" ]; then
    say "母镜像已存在，跳过下载"
  else
    curl -fL --retry 3 --retry-delay 5 --retry-connrefused -o "$WORK/download.img" "$IMG_URL"
    # 不假设上游格式：.img 有时是 qcow2、有时是 raw，一律检测后再决定是否转换。
    FMT=$(qemu-img info --output=json "$WORK/download.img" | tr -d ' \n' | sed -n 's/.*"format":"\([^"]*\)".*/\1/p')
    say "上游格式: ${FMT:-unknown}"
    case "$FMT" in
      qcow2) mv "$WORK/download.img" "$BASE" ;;
      raw)   qemu-img convert -O qcow2 "$WORK/download.img" "$BASE"; rm -f "$WORK/download.img" ;;
      *)     say "不支持的镜像格式: ${FMT:-unknown}"; exit 1 ;;
    esac
    say "母镜像: $(stat -c %s "$BASE") 字节"
  fi

  # 母镜像只读：所有写入落在覆盖层。同一 runner 内重复准备不会污染母镜像。
  qemu-img create -f qcow2 -b "$BASE" -F qcow2 "$OVERLAY" >/dev/null
  say "覆盖层已创建"

  if [ ! -f "$KEY" ]; then
    # 一次性密钥，只在本次 runner 生命周期内存在；teardown 阶段删除。
    ssh-keygen -t ed25519 -N '' -C 'cx-ci-qemu-guest' -f "$KEY" >/dev/null
    say "临时 SSH 密钥已生成"
  fi

  if ! command -v cloud-localds >/dev/null 2>&1; then
    say '未找到 cloud-localds，安装 cloud-image-utils'
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloud-image-utils
  fi

  PUBKEY=$(cat "$PUB")
  cat > "$WORK/user-data" <<EOF
#cloud-config
users:
  - name: ${GUEST_USER}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${PUBKEY}
ssh_pwauth: false
disable_root: true
package_update: false
package_upgrade: false
# 只确保 sshd 起来。不做任何 apt 操作：cloud image 首次启动时 apt 会拖很久。
runcmd:
  - [ systemctl, enable, --now, ssh ]
EOF
  cat > "$WORK/meta-data" <<EOF
instance-id: cx-ci-linux-guest-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}
local-hostname: cx-guest
EOF
  cloud-localds "$SEED" "$WORK/user-data" "$WORK/meta-data"
  say "seed.iso 已生成"
  ;;

# ─────────────────────────────────────────────────────────────────────────────
boot)
  [ -f "$OVERLAY" ] || { say '缺少覆盖层，先跑 --phase prepare'; exit 1; }
  [ -f "$SEED" ] || { say '缺少 seed.iso，先跑 --phase prepare'; exit 1; }

  # 绝对不能加 -no-reboot / -no-shutdown：它们会让客机重启时 QEMU 直接退进程，
  # 「登记 → 重启 → 续删」就断在第二步，而断言会误报成「重启后未回连」。
  # -daemonize 让 QEMU 脱离本 step 的会话，后续 step 才能继续操作这台客机。
  qemu-system-x86_64 \
    -enable-kvm -cpu host -smp 2 -m 2048 \
    -drive file="$OVERLAY",if=virtio,cache=writeback \
    -drive file="$SEED",if=virtio,media=cdrom,readonly=on \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
    -display none -vga none \
    -pidfile "$PIDFILE" -daemonize
  say "QEMU 已 daemonize，pid=$(cat "$PIDFILE" 2>/dev/null || echo unknown)"

  START=$(date +%s)
  if ! wait_ssh boot; then exit 1; fi
  say "BOOT_ELAPSED_SEC=$(( $(date +%s) - START ))"

  say "guest 内核: $(ssh_guest 'uname -r')"
  say "guest boot_id: $(ssh_guest 'cat /proc/sys/kernel/random/boot_id')"

  # KVM 生效的硬证据：kvm-clock 只有在 KVM 下才可能出现，TCG 下是 tsc/hpet。
  # 这条取代了「grep 宿主上的 QEMU 日志」—— -daemonize 之后日志不再进 step 输出。
  CLOCK=$(ssh_guest 'cat /sys/devices/system/clocksource/clocksource0/current_clocksource')
  say "guest clock source: $CLOCK"
  if printf '%s' "$CLOCK" | grep -qi 'kvm-clock'; then
    say 'GUEST_ON_KVM=yes'
  else
    say "GUEST_ON_KVM=no（clock source=$CLOCK，说明没跑在 KVM 上）"
    exit 1
  fi
  ;;

# ─────────────────────────────────────────────────────────────────────────────
register)
  # 记录「重启前」的 boot_id —— replay 阶段靠它证明 guest 真的重启过。
  # 只看文件是否存在、时间戳变化都不足以证明重启，boot_id 是内核给的，重启必变。
  BOOT_BEFORE=$(ssh_guest 'cat /proc/sys/kernel/random/boot_id')
  say "register 阶段 boot_id=$BOOT_BEFORE"

  cat > "$WORK/resume.sh" <<'RESUME'
#!/bin/bash
# 开机续删：由 systemd 在启动时执行，删掉待删目标后自撤销。
set -u
mkdir -p /var/lib/cx-destruct
BOOT_NOW=$(cat /proc/sys/kernel/random/boot_id)
rm -f /var/lib/cx-destruct/target.txt
printf 'resumed_at=%s\nboot_id=%s\n' "$(date -u +%FT%TZ)" "$BOOT_NOW" \
  > /var/lib/cx-destruct/resume-proof.txt
systemctl disable cx-destruct-resume.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/cx-destruct-resume.service
systemctl daemon-reload
RESUME

  # 刻意不用 After=multi-user.target：与 WantedBy=multi-user.target 同时出现
  # 在某些 systemd 版本会构成排序环。After=local-fs.target 足够且无风险。
  cat > "$WORK/unit.service" <<UNIT
[Unit]
Description=Chaoxing Plus CI: resume pending deletions after boot
After=local-fs.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cx-destruct-resume.sh

[Install]
WantedBy=multi-user.target
UNIT

  ssh_guest "sudo mkdir -p $G_DIR"
  scp_to_guest "$WORK/resume.sh" '/tmp/cx-destruct-resume.sh'
  scp_to_guest "$WORK/unit.service" '/tmp/cx-destruct-resume.service'
  ssh_guest 'sudo install -m 0755 /tmp/cx-destruct-resume.sh /usr/local/bin/cx-destruct-resume.sh'
  ssh_guest "sudo install -m 0644 /tmp/cx-destruct-resume.service $G_UNIT"

  # 待删目标 + 重启前 boot_id 落盘，供 replay 交叉核对。
  ssh_guest "printf 'shutdown-destruct-target\n' | sudo tee $G_TARGET >/dev/null"
  ssh_guest "printf '%s\n' '$BOOT_BEFORE' | sudo tee $G_BOOT_BEFORE >/dev/null"
  ssh_guest 'sudo systemctl enable cx-destruct-resume.service'

  # 登记完的现场必须成立，否则后面的断言没有意义。
  TARGET_EXISTS=$(ssh_guest "test -f $G_TARGET && echo yes || echo no")
  UNIT_ENABLED=$(ssh_guest 'systemctl is-enabled cx-destruct-resume.service 2>/dev/null || echo unknown')
  say "登记后: target_exists=$TARGET_EXISTS unit_enabled=$UNIT_ENABLED"
  [ "$TARGET_EXISTS" = yes ] || { say '登记失败：待删目标不存在'; exit 1; }
  [ "$UNIT_ENABLED" = enabled ] || { say "登记失败：续删单元未 enabled（$UNIT_ENABLED）"; exit 1; }
  ;;

# ─────────────────────────────────────────────────────────────────────────────
reboot)
  say '在 guest 内发起重启'
  ssh_guest 'sudo systemctl reboot' || say '（SSH 被重启切断，属预期）'

  say '等待端口关闭…'
  for _ in $(seq 1 60); do
    if ! port_open; then break; fi
    sleep 2
  done
  say "端口已关闭: $(port_open && echo no || echo yes)"

  START=$(date +%s)
  if ! wait_ssh 'reboot'; then exit 1; fi
  say "REBOOT_ELAPSED_SEC=$(( $(date +%s) - START ))"
  ;;

# ─────────────────────────────────────────────────────────────────────────────
replay)
  FAIL=0
  BOOT_AFTER=$(ssh_guest 'cat /proc/sys/kernel/random/boot_id')
  BOOT_BEFORE=$(ssh_guest "cat $G_BOOT_BEFORE 2>/dev/null || echo missing")
  say "boot_before=$BOOT_BEFORE"
  say "boot_after =$BOOT_AFTER"

  # ① 真的重启过：内核 boot_id 变了。缺这条，「重启后文件没了」可能只是没重启。
  if [ "$BOOT_BEFORE" = missing ] || [ "$BOOT_BEFORE" = "$BOOT_AFTER" ]; then
    say '断言失败：boot_id 未变化（客机没有真的重启）'; FAIL=1
  fi

  # ② 待删目标已删。
  TARGET_EXISTS=$(ssh_guest "test -f $G_TARGET && echo yes || echo no")
  say "target_exists_after=$TARGET_EXISTS"
  [ "$TARGET_EXISTS" = no ] || { say '断言失败：待删目标仍存在'; FAIL=1; }

  # ③ 续删单元真的执行过，且是**本次启动**执行的（proof 里的 boot_id == 当前 boot_id）。
  PROOF=$(ssh_guest "cat $G_PROOF 2>/dev/null || echo missing")
  say "resume_proof=$PROOF"
  if [ "$PROOF" = missing ]; then
    say '断言失败：续删单元未执行（无 resume-proof）'; FAIL=1
  else
    PROOF_BOOT=$(printf '%s\n' "$PROOF" | sed -n 's/^boot_id=//p')
    if [ "$PROOF_BOOT" != "$BOOT_AFTER" ]; then
      say "断言失败：续删 proof 的 boot_id ($PROOF_BOOT) 不是本次启动"; FAIL=1
    fi
  fi

  # ④ 续删单元已自撤销。
  UNIT_PRESENT=$(ssh_guest "test -f $G_UNIT && echo yes || echo no")
  UNIT_ENABLED=$(ssh_guest 'systemctl is-enabled cx-destruct-resume.service 2>/dev/null || echo not-found')
  say "unit_present=$UNIT_PRESENT unit_enabled=$UNIT_ENABLED"
  [ "$UNIT_PRESENT" = no ] || { say '断言失败：续删单元文件未自撤销'; FAIL=1; }
  [ "$UNIT_ENABLED" != enabled ] || { say '断言失败：续删单元仍 enabled'; FAIL=1; }

  if [ "$FAIL" -ne 0 ]; then
    say 'REPLAY_VERDICT=failed'
    exit 1
  fi
  say 'REPLAY_VERDICT=passed'
  ;;

# ─────────────────────────────────────────────────────────────────────────────
teardown)
  # 只用来看现场，不做断言：清理失败不该把原始结论覆盖成「清理失败」。
  if qemu_alive; then
    PID=$(cat "$PIDFILE")
    kill -TERM "$PID" 2>/dev/null || true
    sleep 3
    kill -KILL "$PID" 2>/dev/null || true
    say "已结束 QEMU 进程 $PID"
  else
    say 'QEMU 进程已不在'
  fi
  rm -f "$KEY" "$PUB" "$WORK/resume.sh" "$WORK/unit.service"
  say '已删除临时私钥与本地脚本副本'
  ;;

*)
  echo "未知 phase: $PHASE" >&2; exit 2 ;;
esac
