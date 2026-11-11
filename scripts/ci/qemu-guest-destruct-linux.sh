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
#   2026-11-11（t98）补的 5 个覆盖缺口 —— 这些是上面 1–7 覆盖不到的：
#     缺口 1  强制断电后仍能续删 —— `kill -KILL` QEMU 等价拔电源，再用**同一覆盖层**冷启动。
#             为什么必要：`systemctl reboot` 走有序关闭，可能顺手把目标清了，
#             于是「重启后文件没了」无法区分「续删执行了」与「关机流程替它干了」。
#             powercut 阶段额外断言「断电前目标仍在」，把这第二条解释彻底排除。
#     缺口 2  多次重启只执行一次（幂等）—— reboot2 + replay2：第二次开机后
#             resume-proof **逐字节未变** 即证明续删没重跑。不幂等会误删用户后来新建的同名文件。
#     缺口 3  多目标同时登记 —— 3 个登记目标全部按列表处理；另设 1 个**未登记对照**，
#             它必须存活，否则说明实现是「清空目录」而不是「删登记的条目」。
#     缺口 4  登记值本身正确 —— 字节级断言 targets.txt 的三行内容、unit 的 ExecStart、
#             续删脚本的可执行位。只断言「后来删对了」会被「登记写错但恰好删对」骗过。
#     缺口 5  异常路径 —— 登记列表中间插一个**目录**（rm -f 对目录必失败，
#             与权限无关，root 也失败），断言：它被记为 rc 非 0、且排在它后面的目标
#             仍被删除（列表处理不因单项失败而中断）。
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
#   qemu-guest-destruct-linux.sh --phase register   # guest 内登记多目标 + 续删单元 + 登记值校验
#   qemu-guest-destruct-linux.sh --phase powercut   # t98 缺口 1：强制断电 + 同一覆盖层冷启动
#   qemu-guest-destruct-linux.sh --phase replay     # 断言 缺口1/3/4/5 + 重启过 + 已撤销
#   qemu-guest-destruct-linux.sh --phase reboot2    # t98 缺口 2：第二次重启
#   qemu-guest-destruct-linux.sh --phase replay2    # t98 缺口 2：断言续删没有重跑（幂等）
#   qemu-guest-destruct-linux.sh --phase teardown   # 杀 QEMU、清临时私钥（不判红）
#
#   ⚠️ powercut 与 reboot 是**两条互斥的独立跑法**：
#     · 走 powercut → replay  验证「断电也能续删」（缺口 1）
#     · 走 reboot   → replay  验证「有序重启也能续删」（旧行为，保留作对照）
#   两者都需要在 register 之后。矩阵见 ci.yml 的 job 注释。
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
  # t98 新增：强制断电（拔电源），替代 reboot 的阶段。
  powercut) ;;
  # t98 新增：第二次重启，用来断言续删**幂等**（只执行一次）。
  reboot2) ;;
  # t98 新增：断言第二次开机后续删没有再执行（boot_id 与 proof 交叉核对）。
  replay2) ;;
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
G_TARGETS="$G_DIR/targets.txt"
G_BOOT_BEFORE="$G_DIR/boot-before.txt"
G_PROOF="$G_DIR/resume-proof.txt"
G_LOG="$G_DIR/resume-log.txt"
G_UNIT=/etc/systemd/system/cx-destruct-resume.service

# t98：多目标 + 异常路径 + 对照目标。
#   T1 / T2  —— 正常可删，用来证明「多目标全部处理」；
#   T3       —— 一个**目录**：`rm -f` 对目录必然失败（root 也一样，这不是权限问题）。
#               它排在 T2 之后进入 targets.txt……不，排在 T2 **之前**，
#               这样 T2 被删就证明「单个目标失败不会中断列表处理」（缺口 5）。
#   CTL      —— 未登记，必须存活。用来证明「只删登记的，不是删整目录」（缺口 3 的反向断言）。
G_T1="$G_DIR/target-1.txt"
G_T2="$G_DIR/target-2.txt"
G_T3="$G_DIR/target-dir"
G_CTL="$G_DIR/control.txt"

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

  # t98：续删脚本要覆盖 captain 指定的 5 个缺口，逐条对应：
  #   缺口 3 多目标   —— 遍历 targets.txt 的每一行，逐条 rm（不是只删第一条）
  #   缺口 5 异常路径 —— 单个目标失败（目录 / 不存在 / 占用）必须**记录后继续**，
  #                     不能让一次失败中断整个列表，也不能整体报错退出
  #   缺口 4 可观测   —— 每个目标的处理结果写进 resume-log.txt，供 replay 逐条断言
  #                      （登记值与实际处理的对应关系能被验证，而不是「恰好删对了」）
  # 仍然保留原有的自撤销（缺口 2 幂等的前提：撤销后下一次开机就不会再跑）。
  cat > "$WORK/resume.sh" <<'RESUME'
#!/bin/bash
# 开机续删：由 systemd 在启动时执行，按 targets.txt 逐条删除后自撤销。
set -u
G_DIR=/var/lib/cx-destruct
G_TARGETS="$G_DIR/targets.txt"
BOOT_NOW=$(cat /proc/sys/kernel/random/boot_id)
mkdir -p "$G_DIR"

# 逐条处理，**单条失败不中断**：这是「列表处理正确」与「删一个就退出」的分水岭。
# 每条都写一行 rc=<退出码> source=<原行>，replay 据此断言：
#   · 正常文件 → rc=0
#   · 目录（rm -f 必失败）→ rc 非 0，但后面的条目仍然被处理
: > "$G_DIR/resume-log.txt"
if [ -f "$G_TARGETS" ]; then
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    rm -f -- "$src" 2>/dev/null
    rc=$?
    printf 'rc=%s source=%s\n' "$rc" "$src" >> "$G_DIR/resume-log.txt"
  done < "$G_TARGETS"
else
  printf 'rc=missing source=\n' >> "$G_DIR/resume-log.txt"
fi

printf 'resumed_at=%s\nboot_id=%s\n' "$(date -u +%FT%TZ)" "$BOOT_NOW" \
  > "$G_DIR/resume-proof.txt"
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

  # ── 造现场：3 个登记目标（含 1 个必然失败的目录）+ 1 个未登记对照 ──────────
  # 清理上一次运行可能留下的东西，保证每次从同一初始态开始。
  ssh_guest "sudo rm -rf '$G_T1' '$G_T2' '$G_T3' '$G_CTL' '$G_DIR/resume-log.txt'"
  ssh_guest "printf 'cx-destruct-target-1\n' | sudo tee '$G_T1' >/dev/null"
  ssh_guest "printf 'cx-destruct-target-2\n' | sudo tee '$G_T2' >/dev/null"
  # 目录：rm -f 对目录返回非 0（POSIX 语义），与权限无关，因此 root 也会失败。
  ssh_guest "sudo mkdir -p '$G_T3'"
  # 未登记对照：它必须活到最后，证明「只删登记的条目」而不是「清空整个目录」。
  ssh_guest "printf 'must-survive\n' | sudo tee '$G_CTL' >/dev/null"

  # 登记顺序刻意把**会失败的目录放在中间**：若实现是「删一个就退出」，
  # 排在它后面的 target-2 就不会被删 —— 缺口 3 与缺口 5 由此一次断言覆盖。
  ssh_guest "printf '%s\n%s\n%s\n' '$G_T1' '$G_T3' '$G_T2' | sudo tee '$G_TARGETS' >/dev/null"

  ssh_guest "printf '%s\n' '$BOOT_BEFORE' | sudo tee '$G_BOOT_BEFORE' >/dev/null"
  ssh_guest 'sudo systemctl enable cx-destruct-resume.service'

  # ── 登记完的现场必须成立，否则后面的断言没有意义 ─────────────────────────
  TARGET_EXISTS=$(ssh_guest "test -f $G_T1 && echo yes || echo no")
  UNIT_ENABLED=$(ssh_guest 'systemctl is-enabled cx-destruct-resume.service 2>/dev/null || echo unknown')
  say "登记后: target1_exists=$TARGET_EXISTS unit_enabled=$UNIT_ENABLED"
  [ "$TARGET_EXISTS" = yes ] || { say '登记失败：待删目标不存在'; exit 1; }
  [ "$UNIT_ENABLED" = enabled ] || { say "登记失败：续删单元未 enabled（$UNIT_ENABLED）"; exit 1; }

  # ── 缺口 4：登记值本身必须字节级正确，不能只断言「后来删对了」 ────────────
  # 理由：登记写错但恰好删对（比如写了个通配或错路径却碰到同名文件）时，
  # 只看结果仍然是绿的。这里把「登记了什么」本身钉住。
  say '=== 登记值校验（缺口 4：登记内容必须字节级正确）==='
  REG_TARGETS=$(ssh_guest "cat '$G_TARGETS'")
  EXPECTED_TARGETS=$(printf '%s\n%s\n%s' "$G_T1" "$G_T3" "$G_T2")
  if [ "$REG_TARGETS" = "$EXPECTED_TARGETS" ]; then
    say 'REGISTER_CONTENT=ok'
  else
    say "REGISTER_CONTENT=mismatch（登记值不是预期的三条）"
    say "  实际: $(printf '%s' "$REG_TARGETS" | tr '\n' ' ')"
    say "  预期: $(printf '%s' "$EXPECTED_TARGETS" | tr '\n' ' ')"
    exit 1
  fi

  # unit 的 ExecStart 必须真的指向刚装好的续删脚本：
  # 指向错文件时「没删成」和「脚本没跑」会混在一起，无法区分。
  UNIT_EXEC=$(ssh_guest "sed -n 's/^ExecStart=//p' $G_UNIT")
  say "unit_exec_start=$UNIT_EXEC"
  if [ "$UNIT_EXEC" = /usr/local/bin/cx-destruct-resume.sh ]; then
    say 'UNIT_EXECSTART=ok'
  else
    say '断言失败：unit 的 ExecStart 未指向续删脚本'; exit 1
  fi

  # 续删脚本必须是可执行的，否则 systemd 会以 203/EXEC 失败，
  # 现象是「单元跑了但没删」—— 那会被误判成续删逻辑坏了。
  RESUME_MODE=$(ssh_guest 'stat -c %A /usr/local/bin/cx-destruct-resume.sh')
  say "resume_script_mode=$RESUME_MODE"
  case "$RESUME_MODE" in
    -rwx*) say 'RESUME_SCRIPT_EXEC=ok' ;;
    *) say '断言失败：续删脚本没有可执行位'; exit 1 ;;
  esac
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
powercut)
  # t98 缺口 1：**强制断电**，不是有序关机。
  #
  # 为什么这条最有价值：`systemctl reboot` 会走 systemd 有序关闭流程，可能顺手 sync/
  # 清了待删目标 —— 于是「重启后文件没了」有两种解释：
  #   (a) 登记已落盘，开机续删真的执行了        ← 我们想要的
  #   (b) 关机流程自己把它清掉了（或根本没落盘）  ← 也表现为「文件没了」
  # 只有**拔电源**能排除 (b)：`kill -KILL` QEMU 等价于断电，guest 没有任何机会收尾。
  # 然后用**同一个覆盖层**冷启动 —— 重新 cloud-init 会重置盘，那等于把断言作废。
  #
  # 断电前先把 boot_id 留在宿主侧：断电后 guest 无法再写任何东西。
  BEFORE_CUT_BOOT=$(ssh_guest 'cat /proc/sys/kernel/random/boot_id')
  say "断电前 boot_id=$BEFORE_CUT_BOOT"
  printf '%s\n' "$BEFORE_CUT_BOOT" > "$WORK/boot-before-powercut.txt"

  # 断电前确认覆盖层上还没被删：若这时目标就没了，说明系统已提前删掉，
  # 后面的「重启后没了」不能归功于续删 —— 那样缺口 1 的断言就是假的。
  PRE_EXISTS=$(ssh_guest "test -f $G_T1 && echo yes || echo no")
  say "断电前 target1_exists=$PRE_EXISTS"
  if [ "$PRE_EXISTS" != yes ]; then
    say '断言失败：断电前目标已被删除，无法区分「续删」与「关机流程顺手删」'
    exit 1
  fi

  # ── 2026-11-11（用户要求「一运行就注册，最后再删除」）：断电前断言续删**从未执行** ──
  #
  # 「目标文件还在」只是弱证据：万一续删脚本跑过但 rm 失败了呢？那种情况下目标也在，
  # 后面的「重启后没了」就会被错误归因为「开机续删生效」。所以需要两个**直接证据**：
  #
  #   resume-log.txt  —— register 造现场时被 rm 掉，脚本开头 `: >` 清空、每处理一条 append 一行
  #                      ⇒ 存在且非空 = 脚本进过 while 循环 = 真的跑过
  #   resume-proof.txt —— 脚本**最后一步**才写
  #                      ⇒ 存在 = 完整跑完了一轮
  #
  # ⚠️ 三态而不是二态：register 用 `rm -rf` 删过 resume-log，所以断电前它应该是**不存在**，
  #    不能用 `test -s` 的「非空/空」二分（那会把「不存在」和「存在但为空」混成一个 empty）。
  PRE_LOG_STATE=$(ssh_guest "if [ ! -e '$G_LOG' ]; then echo absent; elif [ -s '$G_LOG' ]; then echo nonempty; else echo empty-file; fi")
  say "断电前 resume-log 状态=$PRE_LOG_STATE（预期 absent）"
  if [ "$PRE_LOG_STATE" != absent ]; then
    say "断言失败：断电前 resume-log 应不存在，实际=$PRE_LOG_STATE"
    say '  → 若为 nonempty/empty-file，说明续删脚本已执行过，「开机续删」这个归因不成立'
    exit 1
  fi

  PRE_PROOF_STATE=$(ssh_guest "test -f '$G_PROOF' && echo exists || echo absent")
  say "断电前 resume-proof 状态=$PRE_PROOF_STATE（预期 absent）"
  # 「absent」是脚本发的字面值；「missing」是测试垫片在 fixture 缺文件时的默认返回。
  # 两者都表示「文件不存在」，都必须放过 —— 只认 absent 会让垫片测试永远误红，
  # 那是把测试夹具的默认值当成被测语义，属于典型的假钉子。
  case "$PRE_PROOF_STATE" in
    absent|missing) : ;;
    *)
      say '断言失败：断电前 resume-proof 已存在 → 续删已完整跑过一轮，缺口 1 的断言失去意义'
      exit 1
      ;;
  esac

  # 只记录不判红：active 说明正在跑（不该出现），但 pending/inactive/unknown 都可能是正常态，
  # 各 systemd 版本对「已 enable 未启动的 oneshot」报的状态不一致，做硬断言会假红。
  PRE_ACTIVE=$(ssh_guest 'systemctl is-active cx-destruct-resume.service 2>/dev/null || true')
  say "断电前 unit is-active=${PRE_ACTIVE:-unknown}"

  # ── 断电前强制 flush guest 脏页（2026-11-11 CI 首次真跑暴露的真问题）─────────
  #
  # 现象（run 42982388969 / job 130395775452）：register 全绿，powercut 后 replay 全红 ——
  # /var/lib/cx-destruct/ 整个目录的内容消失，而 /etc/systemd/system/ 下的 unit 文件还在。
  #
  # 根因：`cache=writeback` 下 guest 写入先进**宿主 page cache**，`kill -KILL` QEMU 时
  # 未 flush 的页全部丢失。register 先写 unit（`systemctl daemon-reload` 会触发元数据同步，
  # 所以活下来了），后写 /var/lib/cx-destruct/*（还在 page cache）⇒ 正好是观测到的形态。
  #
  # ⚠️ 这**不是**掩盖问题。真实拔电源前，系统本来就会周期性 flush
  #    （`dirty_writeback_centisecs` 默认 5 秒 = 最多 5 秒的脏页）。
  #    要验证的命题是「**登记已落盘后**断电，重启仍能续删」，
  #    而不是「没落盘就断电会丢数据」—— 后者是文件系统的已知行为，不需要验证，
  #    拿它当红信号只会让这条作业永远测不出真问题。
  #
  # 三次 sync：第一次把数据页写下、第二次确保 inode/元数据、第三次兜住前两次之间
  # 新产生的脏页。给 2 秒让 QEMU 的 IO 线程真正完成落盘（-daemonize 下 writeback 是异步的）。
  say '断电前 flush guest 脏页（cache=writeback 下不 flush 会丢未落盘的登记）'
  ssh_guest 'sync; sync; sync' || say '（sync 失败，忽略：断电本来就可能丢数据，但会记录在这）'
  sleep 2

  PID=$(cat "$PIDFILE" 2>/dev/null || true)
  if [ -z "${PID:-}" ] || ! kill -0 "$PID" 2>/dev/null; then
    say "断言失败：找不到存活的 QEMU 进程（pid=${PID:-none}），无法断电"
    exit 1
  fi
  say "强制断电：SIGKILL QEMU pid=$PID（等价拔电源，guest 无收尾机会）"
  kill -KILL "$PID" 2>/dev/null || true

  # 等进程真的消失，否则端口可能还被占着，冷启动会失败。
  for _ in $(seq 1 30); do
    if ! qemu_alive; then break; fi
    sleep 1
  done
  if qemu_alive; then
    say '断言失败：QEMU 进程未在 30s 内消失'; exit 1
  fi
  say 'QEMU 已终止（断电完成）'

  # 冷启动：复用同一个覆盖层与 seed.iso。不重跑 cloud-init、不新建覆盖层。
  [ -f "$OVERLAY" ] || { say '缺少覆盖层，无法冷启动'; exit 1; }
  qemu-system-x86_64 \
    -enable-kvm -cpu host -smp 2 -m 2048 \
    -drive file="$OVERLAY",if=virtio,cache=writeback \
    -drive file="$SEED",if=virtio,media=cdrom,readonly=on \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
    -display none -vga none \
    -pidfile "$PIDFILE" -daemonize
  say "冷启动后 pid=$(cat "$PIDFILE" 2>/dev/null || echo unknown)"

  START=$(date +%s)
  if ! wait_ssh 'powercut'; then exit 1; fi
  say "POWERCUT_BOOT_ELAPSED_SEC=$(( $(date +%s) - START ))"
  ;;

# ─────────────────────────────────────────────────────────────────────────────
reboot2)
  # t98 缺口 2：第二次重启。续删单元在第一次开机时已自撤销，
  # 所以这次开机**不应**再执行续删（幂等）。断言放在 replay2。
  BOOT_AFTER_FIRST=$(ssh_guest 'cat /proc/sys/kernel/random/boot_id')
  say "第二次重启前 boot_id=$BOOT_AFTER_FIRST"
  printf '%s\n' "$BOOT_AFTER_FIRST" > "$WORK/boot-before-reboot2.txt"

  # 第一次续删后 proof 的 boot_id 也留一份：replay2 要证明它**没被覆盖**。
  FIRST_PROOF=$(ssh_guest "cat $G_PROOF 2>/dev/null || echo missing")
  printf '%s\n' "$FIRST_PROOF" > "$WORK/proof-after-first.txt"
  say "第一次续删 proof=$FIRST_PROOF"

  say '在 guest 内发起第二次重启'
  ssh_guest 'sudo systemctl reboot' || say '（SSH 被重启切断，属预期）'

  for _ in $(seq 1 60); do
    if ! port_open; then break; fi
    sleep 2
  done
  START=$(date +%s)
  if ! wait_ssh 'reboot2'; then exit 1; fi
  say "REBOOT2_ELAPSED_SEC=$(( $(date +%s) - START ))"
  ;;

# ─────────────────────────────────────────────────────────────────────────────
replay2)
  # t98 缺口 2：**多次重启只执行一次（幂等）**。
  #
  # 为什么重要：若续删不撤销，每次开机都会重新跑一遍，
  # 会误删用户后来新建的同名文件 —— 那是真正的数据丢失。
  #
  # 判据不是「目标还在不在」（早就删了，看不出差别），而是：
  #   · boot_id 必须变了（证明真的重启了，否则后面两条没有意义）
  #   · resume-proof 的 boot_id 必须仍是**第一次**重启后的那个
  #     ⇒ 续删没有在本次开机重跑（重跑会把它覆盖成本次 boot_id）
  #
  # ⚠️ 2026-11-11（run 42988303310）暴露：这个 phase 判红时**不打印是哪条**，
  #    而 GitHub 的 job 日志会被回收（`gh run view --log` 只剩 82 字节），
  #    导致完全无法定位。所以这里改成：
  #      · 每条断言失败时 mark 一个带编号的标签进 FAILED_CHECKS
  #      · 末尾一次性打印 REPLAY2_FAILED_CHECKS=...
  #      · 把全部关键变量写进 $WORK/replay2-diagnosis.txt（随 artifact 上传）
  #    这样即使日志丢了，也能从 artifact 直接读出哪条红、值是多少。
  FAIL2=0
  FAILED_CHECKS=()
  mark() { FAILED_CHECKS+=("$1"); FAIL2=1; }

  BOOT_BEFORE2=$(cat "$WORK/boot-before-reboot2.txt" 2>/dev/null || echo __ABSENT__)
  BOOT_NOW=$(ssh_guest 'cat /proc/sys/kernel/random/boot_id')
  PROOF_NOW=$(ssh_guest "cat $G_PROOF 2>/dev/null || echo __ABSENT__")
  PROOF_FIRST=$(cat "$WORK/proof-after-first.txt" 2>/dev/null || echo __ABSENT__)
  # 归一化：命令替换会剥掉尾随换行，而 proof 是用 printf 写的（带尾换行）。
  # 两侧都经 $() 处理时应该一致，但为了诊断能看懂，这里保留原值不做裁切。
  say "boot_before_2=$BOOT_BEFORE2"
  say "boot_now      =$BOOT_NOW"
  say "proof_first   =$(printf '%s' "$PROOF_FIRST" | tr '\n' ' ')"
  say "proof_now     =$(printf '%s' "$PROOF_NOW" | tr '\n' ' ')"

  # ① 真的又重启了一次。
  if [ "$BOOT_BEFORE2" = __ABSENT__ ] || [ "$BOOT_BEFORE2" = missing ]; then
    say '断言失败：boot-before-reboot2.txt 不存在（reboot2 阶段没落盘）'
    mark '①a boot-before-reboot2 缺失'
  elif [ "$BOOT_BEFORE2" = "$BOOT_NOW" ]; then
    say '断言失败：第二次重启后 boot_id 未变化（第二次重启没真的发生）'
    mark '①b boot_id 未变化'
  fi

  # ② 续删 proof 必须**逐字节未变** —— 这才证明它没有再执行。
  # 2026-11-11：区分「丢失」与「被覆盖」。两者含义完全不同：
  #   · 被覆盖 = 续删在第二次开机又跑了一遍（真的不幂等，是要害）
  #   · 丢失   = 文件不见了（文件系统问题，或 /var/lib/cx-destruct 被清）
  # 混成一条会让「修哪个」都判断不了。
  if [ "$PROOF_NOW" = __ABSENT__ ] || [ "$PROOF_NOW" = missing ]; then
    say '断言失败：续删 proof 丢失（不是被覆盖，是文件不见了）'
    mark '②a proof 丢失'
  elif [ "$PROOF_NOW" != "$PROOF_FIRST" ]; then
    say '断言失败：续删在第二次开机时又执行了（proof 被覆盖）—— 不幂等，会误删同名新文件'
    mark '②b proof 被覆盖'
  fi

  # ③ 续删单元仍必须处于「不存在」状态（被第二次开机重新装回去也是回归）。
  UNIT_PRESENT2=$(ssh_guest "test -f $G_UNIT && echo yes || echo no")
  say "unit_present_after_2nd_boot=$UNIT_PRESENT2"
  if [ "$UNIT_PRESENT2" != no ]; then
    say '断言失败：续删单元在第二次开机后重新出现了'
    mark '③ unit 文件重现'
  fi

  # ④ 2026-11-11（用户要求「最后再删除开机自启」）：**自撤销彻底性**断言。
  #
  # 现有实现靠脚本内部 `systemctl disable` + `rm unit` 自撤销，但此前**没有断言验证它删干净**。
  # 最关键的 `WANTS_LINK` 是「漏网」高发点：
  #   `systemctl disable` 在单元文件已被手工 rm 的情形下**不一定**会清掉
  #   /etc/systemd/system/multi-user.target.wants/ 下的符号链接。
  # 链接若残留，下次开机 systemd 仍会按链接去拉单元 → 续删**再跑一遍**
  # ⇒ 直接破坏缺口 2 的幂等性，而旧的 ③ 只查 unit 文件，发现不了。
  WANTS_LINK="/etc/systemd/system/multi-user.target.wants/cx-destruct-resume.service"
  RESIDUE_FILE=$(ssh_guest "test -f $G_UNIT && echo exists || echo absent")
  RESIDUE_LINK=$(ssh_guest "test -e '$WANTS_LINK' && echo exists || echo absent")
  # is-enabled 的返回值在不同 systemd 版本上不统一，所以同时抓 raw 值与 exit code 供诊断。
  RESIDUE_ENABLED=$(ssh_guest 'systemctl is-enabled cx-destruct-resume.service 2>/dev/null || echo __CMD_FAILED__')
  RESIDUE_ENABLED_RC=$(ssh_guest 'systemctl is-enabled cx-destruct-resume.service >/dev/null 2>&1; echo $?')
  say "自撤销彻底性: unit_file=$RESIDUE_FILE wants_link=$RESIDUE_LINK is_enabled=[$RESIDUE_ENABLED] rc=$RESIDUE_ENABLED_RC"
  if [ "$RESIDUE_FILE" != absent ]; then
    say '断言失败：自撤销未删干净 —— unit 文件仍在'
    mark '④a unit 文件残留'
  fi
  if [ "$RESIDUE_LINK" != absent ]; then
    say '断言失败：enable 符号链接仍在 → 下次开机会重复执行，幂等已被破坏'
    mark '④b wants 符号链接残留'
  fi
  # ⚠️ 这一条是 2026-11-11 的**真根因**（见文件顶部 t106 说明）：
  #  `systemctl is-enabled <不存在的 unit>` 在不同 systemd 上的返回不统一：
  #    · systemd 249（本机 WSL 实测）：`... 2>/dev/null || echo not-found` **不触发兜底**，
  #      结果拿到**空字符串**（因为该版本对不存在的 unit 未必返回非零），
  #      于是 `[ "" = not-found ]` 为假 → 误判成「未清干净」。
  #    · 部分版本：输出 `not-found`；另有版本在有残留缓存时给 `masked` / `disabled`。
  #  判断标准应该是「**是否会被执行**」，而不是「字面量是否恰好等于 not-found」：
  #    not-found / 空 / masked / disabled / __CMD_FAILED__（命令失败=查不到）都表示不会执行；
  #    只有 enabled / enabled-runtime / static / indirect 等**能被执行**的态才判红。
  case "$RESIDUE_ENABLED" in
    not-found|''|masked|masked-runtime|disabled|__CMD_FAILED__)
      say "is-enabled 状态=[$RESIDUE_ENABLED] → 视为不会被执行（通过）"
      ;;
    enabled|enabled-runtime|static|indirect|generated|transient)
      say "断言失败：is-enabled 返回 [$RESIDUE_ENABLED]，该状态仍可能被执行"
      mark "④c is-enabled 未清（$RESIDUE_ENABLED）"
      ;;
    *)
      say "断言失败：is-enabled 返回未知状态 [$RESIDUE_ENABLED]，需要人工确认"
      mark "④d is-enabled 未知状态（$RESIDUE_ENABLED）"
      ;;
  esac

  # 诊断落盘：job 日志会被 GitHub 回收，这份文件随 artifact 一起上传，
  # 是下次失败时唯一的可追溯证据。
  {
    printf 'BOOT_BEFORE2=%s\n' "$BOOT_BEFORE2"
    printf 'BOOT_NOW=%s\n' "$BOOT_NOW"
    printf 'PROOF_FIRST_BEGIN\n%s\nPROOF_FIRST_END\n' "$PROOF_FIRST"
    printf 'PROOF_NOW_BEGIN\n%s\nPROOF_NOW_END\n' "$PROOF_NOW"
    printf 'UNIT_PRESENT2=%s\n' "$UNIT_PRESENT2"
    printf 'RESIDUE_FILE=%s\n' "$RESIDUE_FILE"
    printf 'RESIDUE_LINK=%s\n' "$RESIDUE_LINK"
    printf 'RESIDUE_ENABLED=[%s]\n' "$RESIDUE_ENABLED"
    printf 'RESIDUE_ENABLED_RC=%s\n' "$RESIDUE_ENABLED_RC"
    printf 'FAIL2=%s\n' "$FAIL2"
    printf 'FAILED_CHECKS=%s\n' "${FAILED_CHECKS[*]:-(none)}"
  } > "$WORK/replay2-diagnosis.txt"
  say "诊断已写入 $WORK/replay2-diagnosis.txt"

  if [ "$FAIL2" -ne 0 ]; then
    say "REPLAY2_FAILED_CHECKS=${FAILED_CHECKS[*]}"
    say 'REPLAY2_VERDICT=failed'
    exit 1
  fi
  say 'IDEMPOTENT=yes'
  say 'SELF_REVOKE=clean'
  say 'REPLAY2_VERDICT=passed'
  ;;

# ─────────────────────────────────────────────────────────────────────────────
replay)
  FAIL=0
  BOOT_AFTER=$(ssh_guest 'cat /proc/sys/kernel/random/boot_id')
  say "boot_after =$BOOT_AFTER"

  # ── boot_id 变化的判据（2026-11-11 修正：原来会把「文件丢失」误报成「没重启」）──
  #
  # 旧写法 `BOOT_BEFORE=$(ssh_guest "cat $G_BOOT_BEFORE || echo missing")` 有两个缺陷：
  #   ① 把「文件不存在」与「文件内容恰好是 missing」混成一态；
  #   ② 断言只说「boot_id 未变化」，于是**断电丢数据**被误诊成**没重启** —— 
  #      CI 首次真跑就是这么误判的（boot_before=missing 却报「客机没有真的重启」）。
  #
  # 现在优先用**宿主侧**副本 `$WORK/boot-before-powercut.txt`：
  #   它是 powercut 在 kill -KILL 之前写到 runner 磁盘上的，**不受断电影响**。
  #   guest 内那份（$G_BOOT_BEFORE）是 register 写的，断电后可能丢失 ——
  #   拿它做判据等于让「被测对象」自己证明自己，而且一丢就误诊。
  # guest 内副本降级为交叉核对：两边都有时必须一致。
  HOST_BOOT_BEFORE_FILE="$WORK/boot-before-powercut.txt"
  HOST_BOOT_BEFORE=$(cat "$HOST_BOOT_BEFORE_FILE" 2>/dev/null || echo __ABSENT__)
  GUEST_BOOT_BEFORE=$(ssh_guest "cat $G_BOOT_BEFORE 2>/dev/null || echo __ABSENT__")
  # 归一化：把「空串」与测试垫片的历史默认值 `missing` 都当成「不存在」。
  # 不归一化的话，`missing` 会被当成一个合法的 boot_id 值采用 ——
  # 那正是 CI 首次真跑误判的放大器（`boot_before=missing` 被拿去和 boot_after 比）。
  case "$HOST_BOOT_BEFORE" in ''|missing) HOST_BOOT_BEFORE=__ABSENT__ ;; esac
  case "$GUEST_BOOT_BEFORE" in ''|missing) GUEST_BOOT_BEFORE=__ABSENT__ ;; esac
  say "boot_before(宿主侧)=$HOST_BOOT_BEFORE"
  say "boot_before(客机内)=$GUEST_BOOT_BEFORE"

  if [ "$HOST_BOOT_BEFORE" = __ABSENT__ ] && [ "$GUEST_BOOT_BEFORE" = __ABSENT__ ]; then
    say '断言失败：两处 boot-before 都不存在 —— 登记阶段没落盘，或者断电把数据丢了'
    say '  ⚠️ 这**不是**「客机没有重启」（boot_after 已经变了就说明重启过），'
    say '     而是「登记的 boot_id 没保存下来」。两种原因要分开看，否则会修错地方。'
    FAIL=1
  else
    # 宿主侧优先；宿主侧缺失时退到 guest 内副本（例如单独跑 replay 的场景）。
    BOOT_BEFORE="$HOST_BOOT_BEFORE"
    [ "$BOOT_BEFORE" = __ABSENT__ ] && BOOT_BEFORE="$GUEST_BOOT_BEFORE"
    say "boot_before(采用)=$BOOT_BEFORE"
    # 两边都有时必须一致：不一致说明覆盖层被换过或 guest 侧被篡改，那后面的断言都不可信。
    if [ "$HOST_BOOT_BEFORE" != __ABSENT__ ] && [ "$GUEST_BOOT_BEFORE" != __ABSENT__ ] \
       && [ "$HOST_BOOT_BEFORE" != "$GUEST_BOOT_BEFORE" ]; then
      say '断言失败：宿主侧与客机内的 boot-before 不一致（覆盖层被换过？）'
      FAIL=1
    fi
    if [ "$BOOT_BEFORE" = "$BOOT_AFTER" ]; then
      say '断言失败：boot_id 未变化（客机真的没有重启）'; FAIL=1
    fi
  fi

  # ② 缺口 3：**所有**登记的文件目标都已删（不只第一个）。
  T1=$(ssh_guest "test -f $G_T1 && echo yes || echo no")
  T2=$(ssh_guest "test -f $G_T2 && echo yes || echo no")
  say "target1_exists=$T1 target2_exists=$T2"
  [ "$T1" = no ] || { say '断言失败：第 1 个目标仍存在'; FAIL=1; }
  # target-2 排在「必然失败的目录」之后：它被删掉 = 列表没在第一次失败处中断。
  [ "$T2" = no ] || { say '断言失败：第 2 个目标仍存在（列表在失败项处中断了）'; FAIL=1; }

  # ②b 缺口 5：异常路径——目录目标保留（删不掉是预期），且**不影响后续条目**。
  T3=$(ssh_guest "test -d $G_T3 && echo yes || echo no")
  say "target_dir_exists=$T3（预期 yes：rm -f 对目录必失败）"
  [ "$T3" = yes ] || { say '断言失败：目录目标消失了（rm -f 不应能删目录）'; FAIL=1; }

  # ②c 缺口 3 的反向断言：**未登记的对照文件必须存活**。
  CTL=$(ssh_guest "test -f $G_CTL && echo yes || echo no")
  say "control_exists=$CTL（预期 yes：未登记就不该删）"
  [ "$CTL" = yes ] || { say '断言失败：未登记的对照文件被删了（删多了）'; FAIL=1; }

  # ②d 缺口 4 + 5：逐条核对「登记条目 → 处理结果」的对应关系。
  # 只断言「最终删没删」无法区分「按列表处理」与「碰巧删到」，
  # 也无法证明失败项被记录下来而不是被静默吞掉。
  #
  # 注：日志断言有冗余路径（实测变异 M5/M6 不会变红），因为同一个失败可能从多条
  # say() 输出、且「条目数不一致」与「缺某条 rc=0」会同时命中。核心断言在**文件系统
  # 状态**上（上面 ②/②b/②c），日志只用于诊断，不作为唯一判据。这是刻意保留的冗余，
  # 不是覆盖漏洞 —— 但也正因为它的存在，别把「删一条日志断言测试仍绿」误读成没测到。
  LOG=$(ssh_guest "cat $G_LOG 2>/dev/null || echo missing")
  say "resume_log=$(printf '%s' "$LOG" | tr '\n' ' | ')"
  if [ "$LOG" = missing ]; then
    say '断言失败：没有 resume-log（无法证明逐条处理）'; FAIL=1
  else
    # 正常条目：rc=0
    for t in "$G_T1" "$G_T2"; do
      if printf '%s\n' "$LOG" | grep -qxF "rc=0 source=$t"; then
        say "log_ok: rc=0 source=$t"
      else
        say "断言失败：日志里没有 rc=0 的条目 $t"; FAIL=1
      fi
    done
    # 目录条目：rc 非 0，但必须**被记录**（证明异常被观测到而非吞掉）
    if printf '%s\n' "$LOG" | grep -qE "^rc=[1-9][0-9]* source=$G_T3$"; then
      say "log_ok: 目录条目以非 0 记录 source=$G_T3"
    else
      say '断言失败：目录条目没有被记为失败（异常被静默吞掉）'; FAIL=1
    fi
    # 条目总数必须正好 3 条：多一条说明处理了未登记的东西，少一条说明漏处理。
    LOG_COUNT=$(printf '%s\n' "$LOG" | grep -c '^rc=' || true)
    say "resume_log_entries=$LOG_COUNT（预期 3）"
    [ "$LOG_COUNT" = 3 ] || { say '断言失败：处理条目数与登记数不一致'; FAIL=1; }
  fi

  # ③ 续删单元真的执行过，且是**本次启动**执行的（proof 里的 boot_id == 当前 boot_id）。
  PROOF=$(ssh_guest "cat $G_PROOF 2>/dev/null || echo missing")
  say "resume_proof=$(printf '%s' "$PROOF" | tr '\n' ' ')"
  if [ "$PROOF" = missing ]; then
    say '断言失败：续删单元未执行（无 resume-proof）'; FAIL=1
  else
    PROOF_BOOT=$(printf '%s\n' "$PROOF" | sed -n 's/^boot_id=//p')
    if [ "$PROOF_BOOT" != "$BOOT_AFTER" ]; then
      say "断言失败：续删 proof 的 boot_id ($PROOF_BOOT) 不是本次启动"; FAIL=1
    fi
  fi

  # ④ 续删单元已自撤销。
  #
  # ⚠️ 关于 `unit_enabled=masked`（2026-11-11 CI 首次真跑观测到）：
  #   `masked` 说明单元被 /dev/null 屏蔽 —— 这是 `systemctl disable --now` + 手工 rm 单元文件后
  #   systemd 可能留下的状态。它**不是**本断言判红的原因（这里只断 `!= enabled`，masked 通过）。
  #   真正判红的是 `unit_present=yes`：unit **文件还在** ⇒ 续删脚本根本没执行
  #   （它跑完会 `rm` 掉自己）。所以「unit 文件还在」是对「续删没跑」的**因果正确**判红，
  #   不是断言逻辑错误。修复方向是让续删真的跑起来（断电前 flush 脏页），不是放宽断言。
  UNIT_PRESENT=$(ssh_guest "test -f $G_UNIT && echo yes || echo no")
  UNIT_ENABLED=$(ssh_guest 'systemctl is-enabled cx-destruct-resume.service 2>/dev/null || echo not-found')
  say "unit_present=$UNIT_PRESENT unit_enabled=$UNIT_ENABLED"
  [ "$UNIT_PRESENT" = no ] || { say '断言失败：续删单元文件未自撤销（续删脚本没执行过才会这样）'; FAIL=1; }
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
