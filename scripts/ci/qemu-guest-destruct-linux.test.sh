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
  #
  # ⚠️ t101 踩坑：三态判断那句命令里**同时含** "resume-log.txt"，若把
  # `*resume-log*` 放在前面，它会被吞掉并返回 resume_log 的内容（"missing"/"rc=0 ..."），
  # 于是 resume_log_state 永远是 missing，新断言永远不触发 —— 表现为「变异不变红」。
  # 所以三态判断必须排在 *resume-log* 之前。
  *"echo absent; elif"*|*"echo empty-file"*)  pick resume_log_state absent ;;
  # t101：replay2 的自撤销彻底性。同样要先于 unit_present 的 `test -f /etc/systemd/system/`。
  *"multi-user.target.wants"*)                pick wants_link absent ;;
  *boot-before.txt*)                          pick boot_before missing ;;
  *"cat /proc/sys/kernel/random/boot_id"*)    pick boot_id stub-boot ;;
  *resume-proof*)                             pick proof missing ;;
  *resume-log*)                               pick resume_log missing ;;
  # t98：多目标布局。顺序仍要具体优先 —— target-1/2/dir 都含 "target"，
  # 所以用精确文件名匹配，不用通配。
  *"test -f /var/lib/cx-destruct/target-1.txt"*)  pick target1_exists no ;;
  *"test -f /var/lib/cx-destruct/target-2.txt"*)  pick target2_exists no ;;
  *"test -d /var/lib/cx-destruct/target-dir"*)    pick target_dir_exists yes ;;
  *"test -f /var/lib/cx-destruct/control.txt"*)   pick control_exists yes ;;
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
  printf '%s\n' "${5:-no}"             > "$d/target1_exists"
  printf '%s\n' "${6:-no}"             > "$d/unit_present"
  printf '%s\n' "${7:-not-found}"      > "$d/unit_enabled"
  # t98 新增字段（缺口 3/4/5）：目标 2、目录目标、未登记对照、逐条处理日志。
  printf '%s\n' "${8:-no}"             > "$d/target2_exists"
  printf '%s\n' "${9:-yes}"            > "$d/target_dir_exists"
  printf '%s\n' "${10:-yes}"           > "$d/control_exists"
  if [ -n "${11:-}" ]; then
    printf '%s' "$11"                  > "$d/resume_log"
  else
    # 默认「全绿」日志：两条 rc=0 + 一条目录的 rc 非 0，共 3 条。
    printf 'rc=0 source=/var/lib/cx-destruct/target-1.txt\nrc=1 source=/var/lib/cx-destruct/target-dir\nrc=0 source=/var/lib/cx-destruct/target-2.txt\n' \
      > "$d/resume_log"
  fi
  # t101：powercut 三态 + replay2 自撤销彻底性。
  printf '%s\n' "${12:-absent}"        > "$d/resume_log_state"
  printf '%s\n' "${13:-absent}"        > "$d/wants_link"
  echo "$d"
}

RUNDIR="$TMP/run"; mkdir -p "$RUNDIR"
# ⚠️ t101：powercut / replay2 会往 $RUNNER_TEMP/cx-linux-guest/ 下写宿主侧文件
# （boot-before-powercut.txt 等）。若不预建这个目录，脚本会在**写文件**处就 exit 1，
# 于是「应当判红」的 fixture 全部假通过 —— 红的原因不是被测断言，而是目录不存在。
# replay 阶段不需要它（只读 ssh），所以之前的用例没暴露这个问题。
mkdir -p "$RUNDIR/cx-linux-guest"
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

# t101：replay2 与 powercut 也用同一套垫片驱动。
# replay2 需要两个宿主侧文件（boot-before-reboot2.txt / proof-after-first.txt），
# 它们由 reboot2 阶段写；测试里直接预置，等价于「reboot2 已跑过」。
#
# ⚠️ powercut 的特殊处理：它在断言之后还会「找 QEMU 进程 → kill → 冷启动」。
# 测试环境没有 QEMU，所以**每个** powercut 用例都会在那一步 exit 1 ——
# 于是「应当判红」的用例全部假通过（红的原因不是被测断言）。
# 做法：预置一个假的 pidfile 指向本测试进程自身（kill -0 必然成功），
# 让脚本越过「找不到 QEMU」这一步；真正的 kill -KILL 不会执行到
# （目标断言更早就 exit 1，或被测点之后的冷启动会因缺 qemu 失败但那时断言已生效）。
# 需要一个活着的 pid：用 `sleep` 起一个长期子进程最稳。
run_phase() {
  local phase="$1" fixture="$2" out code
  # powercut 需要 pidfile 且要求进程存活（kill -0 通过）。
  # 不能写 $$（脚本会 kill -KILL 它，把测试自己杀掉），
  # 所以起一个 sleep 子进程当替身，用例结束再回收。
  mkdir -p "$RUNDIR/cx-linux-guest"
  sleep 300 &
  local fakeqemu=$!
  printf '%s\n' "$fakeqemu" > "$RUNDIR/cx-linux-guest/qemu.pid"
  out=$(PATH="$TMP/bin:$PATH" \
        CX_FIXTURE="$fixture" \
        RUNNER_TEMP="$RUNDIR" \
        CX_LINUX_GUEST_SSH_PORT=2223 \
        bash "$TARGET" --phase "$phase" 2>&1)
  code=$?
  kill -KILL "$fakeqemu" 2>/dev/null || true
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

# t101：powercut / replay2 的用例**不能只断退出码**。
# 原因：这两个 phase 在目标断言之后还有别的 exit 1 出口
#   powercut → 「缺少覆盖层」（测试环境没有 qcow2）、「QEMU 进程未消失」
#   replay2  → 「unit 文件仍在」（垫片返回 no 而断言要 absent）
# 于是删掉被测断言后退出码仍是 1，变异不变红 —— 典型的「红的原因错位」。
# 正确判据：断言**输出里出现了这条断言的原文**，证明红是被它触发的。
check_msg() {
  local label="$1" out="$2" needle="$3"
  if printf '%s' "$out" | grep -qF "$needle"; then
    echo "  ✔ $label（输出命中「$needle」）"; PASS=$((PASS+1))
  else
    echo "  ✖ $label（输出未命中「$needle」）"; FAIL=$((FAIL+1))
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

# ── t98 新增：5 个覆盖缺口各自的「应判红」fixture ──────────────────────────
# 每条都只改一个维度，保证红的原因唯一，不会「因为别的错也红」而假通过。

echo
echo '=== 9) 缺口 3：第 2 个目标没删（列表只处理了第一条）→ 必须判红 ==='
# 其余全绿，只把 target2_exists 改成 yes。
F=$(mkfix gap3-multi boot-AFTER boot-BEFORE boot-AFTER no no not-found yes yes yes)
run_replay "$F" >/dev/null 2>&1; check '第 2 个目标仍存在（列表中断）' 1 $?

echo
echo '=== 10) 缺口 3 反向：未登记的对照文件被删（删多了）→ 必须判红 ==='
F=$(mkfix gap3b-control boot-AFTER boot-BEFORE boot-AFTER no no not-found no yes no)
run_replay "$F" >/dev/null 2>&1; check '未登记对照被删（删多了）' 1 $?

echo
echo '=== 11) 缺口 5：目录目标消失了（rm -f 不该能删目录）→ 必须判红 ==='
F=$(mkfix gap5-dir-gone boot-AFTER boot-BEFORE boot-AFTER no no not-found no no yes)
run_replay "$F" >/dev/null 2>&1; check '目录目标消失' 1 $?

echo
echo '=== 12) 缺口 5：目录条目没有被记为失败（异常被静默吞掉）→ 必须判红 ==='
# 日志里只有两条 rc=0，缺了目录那条 rc 非 0。
F=$(mkfix gap5-log-silent boot-AFTER boot-BEFORE boot-AFTER no no not-found no yes yes \
  'rc=0 source=/var/lib/cx-destruct/target-1.txt
rc=0 source=/var/lib/cx-destruct/target-2.txt
')
run_replay "$F" >/dev/null 2>&1; check '目录条目未记为失败' 1 $?

echo
echo '=== 13) 缺口 4：日志条目数与登记数不一致（漏处理或多处理）→ 必须判红 ==='
F=$(mkfix gap4-count boot-AFTER boot-BEFORE boot-AFTER no no not-found no yes yes \
  'rc=0 source=/var/lib/cx-destruct/target-1.txt
')
run_replay "$F" >/dev/null 2>&1; check '处理条目数不符' 1 $?

echo
echo '=== 14) 缺口 4：日志里没有对应条目的 rc=0（登记与处理对不上）→ 必须判红 ==='
F=$(mkfix gap4-nolog boot-AFTER boot-BEFORE boot-AFTER no no not-found no yes yes \
  'rc=0 source=/var/lib/cx-destruct/target-1.txt
rc=1 source=/var/lib/cx-destruct/target-dir
rc=0 source=/var/lib/cx-destruct/target-WRONG.txt
')
run_replay "$F" >/dev/null 2>&1; check '登记与处理条目对不上' 1 $?

echo
echo '=== 15) 缺口 3/5 组合：完全无 resume-log → 必须判红 ==='
F=$(mkfix gap-nolog boot-AFTER boot-BEFORE boot-AFTER no no not-found no yes yes 'missing')
run_replay "$F" >/dev/null 2>&1; check '无逐条处理日志' 1 $?

# ── t101：用户要求「一运行就注册、最后再删除」对应的两处新断言 ──────────────
# 这两组是**断电前**（powercut）与**自撤销后**（replay2）的判据，
# 与上面 replay 阶段的断言是不同 phase，必须各自有「应该判红」的反例，
# 否则新加的断言永远绿也没人知道。

echo
echo '=== 16) powercut：断电前 resume-log 已有内容 → 必须判红 ==='
# 场景：续删脚本已经跑过（log 非空），此时断电再冷启动，「文件没了」不能归因于本次续删。
# 判据用 check_msg：这份输出里必须出现该断言的原文，才证明红是它触发的。
F=$(mkfix pc-log-dirty boot-AFTER boot-BEFORE missing yes no not-found no yes yes '' nonempty absent)
OUT=$(run_phase powercut "$F" 2>&1)
check_msg '断电前 resume-log 非空' "$OUT" '断电前 resume-log 应不存在，实际=nonempty'

echo
echo '=== 17) powercut：断电前 resume-log 存在但为空 → 也必须判红 ==='
F=$(mkfix pc-log-emptyfile boot-AFTER boot-BEFORE missing yes no not-found no yes yes '' empty-file absent)
OUT=$(run_phase powercut "$F" 2>&1)
check_msg '断电前 resume-log 空文件' "$OUT" '断电前 resume-log 应不存在，实际=empty-file'

echo
echo '=== 18) powercut：断电前 resume-proof 已存在 → 必须判红 ==='
# proof 是脚本最后一步写的，存在 = 完整跑过一轮。
F=$(mkfix pc-proof-exists boot-AFTER boot-BEFORE boot-AFTER yes no not-found no yes yes '' absent absent)
OUT=$(run_phase powercut "$F" 2>&1)
check_msg '断电前 resume-proof 已存在' "$OUT" '断电前 resume-proof 已存在'

echo
echo '=== 19) replay2：自撤销后 wants 符号链接仍残留 → 必须判红 ==='
# 这条最容易被忽略：unit 文件删了、is-enabled 也返回 not-found，
# 但 multi-user.target.wants 下的链接还在 → 下次开机会重复执行 → 幂等被破坏。
F=$(mkfix r2-wants-left boot-AFTER boot-BEFORE boot-AFTER no no not-found no yes yes '' absent exists)
printf 'boot-2nd\n' > "$RUNDIR/cx-linux-guest/boot-before-reboot2.txt"
printf 'resumed_at=x\nboot_id=boot-AFTER\n' > "$RUNDIR/cx-linux-guest/proof-after-first.txt"
OUT=$(run_phase replay2 "$F" 2>&1)
check_msg 'wants 链接残留' "$OUT" 'enable 符号链接仍在'

echo
echo "结果：$PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] || exit 1
