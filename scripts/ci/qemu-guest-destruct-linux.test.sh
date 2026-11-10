#!/usr/bin/env bash
# qemu-guest-destruct-linux.sh 的 replay 断言自测（本地可跑，不需要 QEMU / KVM / 客机）。
#
# 为什么要有这个：qemu-guest-destruct-linux.sh 的核心价值全在 replay 阶段的四条断言上
# （boot_id 变了 / 目标已删 / 续删 proof 属于本次启动 / 单元已自撤销）。
# 那四条不做变异验证，很容易写成「看起来在断言、实际永远绿」的假钉子。
#
# 做法：给 `ssh` 打一个 PATH 垫片，把客机内命令的返回值按 fixture 回放，
# 然后**原封不动**地跑被测脚本的 --phase replay。于是测的是真实代码路径，
# 不是重写一份逻辑。每个断言各配一个「应当判红」的 fixture，最后再验证全绿 fixture
# 能以 0 退出 —— 四条断言因此各自都被证明有效。
#
# 用法：bash scripts/ci/qemu-guest-destruct-linux.test.sh
# 退出码：0 = 全部通过；1 = 有断言没判红（假钉子）

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TARGET="$SCRIPT_DIR/qemu-guest-destruct-linux.sh"
[ -f "$TARGET" ] || { echo "找不到被测脚本: $TARGET" >&2; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── ssh 垫片：把远端命令映射到 fixture 文件 ───────────────────────────────────
# 真实调用形如： ssh -i KEY -p PORT -o ... user@host "<remote command>"
# 远端命令永远是最后一个参数。
mkdir -p "$TMP/bin"
cat > "$TMP/bin/ssh" <<'SHIM'
#!/usr/bin/env bash
# 最后一个参数是远端命令；按其中的特征串回放 fixture。fixture 目录由 CX_FIXTURE 指定。
for last in "$@"; do :; done
cmd="${last:-}"
F="${CX_FIXTURE:?CX_FIXTURE 未设置}"
pick() {
  local f="$F/$1" d="${2:-}"
  if [ -f "$f" ]; then cat "$f"; else printf '%s\n' "$d"; fi
}
case "$cmd" in
  # 注意顺序：更具体的模式必须排在前面。
  *boot-before.txt*)                          pick boot_before missing ;;
  *"cat /proc/sys/kernel/random/boot_id"*)    pick boot_id stub-boot ;;
  *resume-proof*)                             pick proof missing ;;
  *"test -f /var/lib/cx-destruct/target.txt"*) pick target_exists no ;;
  *"test -f /etc/systemd/system/"*)           pick unit_present no ;;
  *is-enabled*)                               pick unit_enabled not-found ;;
  *) echo "stub: $cmd" ;;
esac
exit 0
SHIM
chmod +x "$TMP/bin/ssh"
# replay 阶段不该调用 scp / qemu；给个会炸的桩，防止误用被静默吞掉。
printf '#!/usr/bin/env bash\necho "unexpected call: $0 $*" >&2\nexit 90\n' > "$TMP/bin/scp"
chmod +x "$TMP/bin/scp"

mkfix() {
  local d="$TMP/fx-$1"; mkdir -p "$d"
  printf '%s\n' "${2:-boot-AAA}"       > "$d/boot_id"
  printf '%s\n' "${3:-boot-AAA}"       > "$d/boot_before"
  printf 'resumed_at=x\nboot_id=%s\n' "${4:-boot-AAA}" > "$d/proof"
  printf '%s\n' "${5:-no}"             > "$d/target_exists"
  printf '%s\n' "${6:-no}"             > "$d/unit_present"
  printf '%s\n' "${7:-not-found}"      > "$d/unit_enabled"
  echo "$d"
}

RUNDIR="$TMP/run"; mkdir -p "$RUNDIR"
run_replay() {
  local fixture="$1" out
  out=$(PATH="$TMP/bin:$PATH" \
        CX_FIXTURE="$fixture" \
        RUNNER_TEMP="$RUNDIR" \
        CX_LINUX_GUEST_SSH_PORT=2223 \
        bash "$TARGET" --phase replay 2>&1)
  local code=$?
  printf '%s\n' "$out"
  return $code
}

PASS=0; FAIL=0
check() {
  local label="$1" expect="$2" actual="$3"
  if [ "$expect" = "$actual" ]; then
    echo "  ✔ $label（期望 exit=$expect，实际 $actual）"; PASS=$((PASS+1))
  else
    echo "  ✖ $label（期望 exit=$expect，实际 $actual）"; FAIL=$((FAIL+1))
  fi
}

echo '=== 1) 全绿 fixture：必须 exit 0 ==='
# 语义：参数依次为 当前boot_id / boot-before / proof.boot_id。
# 重启后当前 boot_id 必须与登记时记录的 boot-before **不同**，且 proof 必须属于当前这次启动。
F=$(mkfix green boot-AFTER boot-BEFORE boot-AFTER no no not-found)
run_replay "$F" >/dev/null 2>&1; check '全部断言成立 → 通过' 0 $?

echo
echo '=== 2) boot_id 没变（客机没真重启）→ 必须判红 ==='
F=$(mkfix sameboot boot-SAME boot-SAME boot-SAME no no not-found)
run_replay "$F" >/dev/null 2>&1; check 'boot_id 未变化' 1 $?

echo
echo '=== 3) boot-before 缺失（登记阶段没落盘）→ 必须判红 ==='
F=$(mkfix nobefore boot-AFTER missing boot-AFTER no no not-found)
run_replay "$F" >/dev/null 2>&1; check 'boot-before 缺失' 1 $?

echo
echo '=== 4) 待删目标仍在 → 必须判红 ==='
F=$(mkfix targetleft boot-AFTER boot-BEFORE boot-AFTER yes no not-found)
run_replay "$F" >/dev/null 2>&1; check '目标未删' 1 $?

echo
echo '=== 5) 续删单元没执行（无 proof）→ 必须判红 ==='
F=$(mkfix noproof boot-AFTER boot-BEFORE missing no no not-found)
run_replay "$F" >/dev/null 2>&1; check '无 resume-proof' 1 $?

echo
echo '=== 6) proof 属于上一次启动（boot_id 不匹配）→ 必须判红 ==='
F=$(mkfix staleold boot-AFTER boot-BEFORE boot-STALE no no not-found)
run_replay "$F" >/dev/null 2>&1; check 'proof 不是本次启动' 1 $?

echo
echo '=== 7) 续删单元文件未自撤销 → 必须判红 ==='
F=$(mkfix unitleft boot-AFTER boot-BEFORE boot-AFTER no yes not-found)
run_replay "$F" >/dev/null 2>&1; check 'unit 文件残留' 1 $?

echo
echo '=== 8) 续删单元仍 enabled → 必须判红 ==='
F=$(mkfix unitenabled boot-AFTER boot-BEFORE boot-AFTER no no enabled)
run_replay "$F" >/dev/null 2>&1; check 'unit 仍 enabled' 1 $?

echo
echo "结果：$PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
