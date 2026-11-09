// Labeled offline fixture set for objective-answer resolution.
//
// Ground truth is the visible option label a correct resolver must select, or
// 'abstain' when no single option can be justified from the provider answer.
// Cases are synthetic: they reproduce Chaoxing markup shapes seen in the
// reference projects (label span + option text inside `.clearfix`), remapped
// platform `data` values, and the answer-text failures the references document
// (signs, ordering, repetition, near-duplicate options).
//
// Fields:
//   id       stable case id
//   kind     resolver entry: single | multiple | judgement | completion
//   mode     answerMatchMode: similar | exact
//   options  [{ label, text, dataValue }] in DOM order
//   answers  provider answer groups (each group is one provider result)
//   expect   visible label(s) that must be selected, or 'abstain'
//   note     why the case exists

export const cases = [
  {
    id: 'single-sign-plus',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: 'x-y', dataValue: 'A' },
      { label: 'B', text: 'x+y', dataValue: 'B' }
    ],
    answers: [['x+y']],
    expect: ['B'],
    note: 'Sign blindness turns x+y into xy and ties with x-y'
  },
  {
    id: 'single-sign-minus',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: 'x+y', dataValue: 'A' },
      { label: 'B', text: 'x-y', dataValue: 'B' }
    ],
    answers: [['x-y']],
    expect: ['B'],
    note: 'Same sign blindness, reversed order'
  },
  {
    id: 'single-repetition',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: 'ab', dataValue: 'A' },
      { label: 'B', text: 'aab', dataValue: 'B' }
    ],
    answers: [['aab']],
    expect: ['B'],
    note: 'Character-set similarity cannot see repeated characters'
  },
  {
    id: 'single-order',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: 'BA', dataValue: 'A' },
      { label: 'B', text: 'AB', dataValue: 'B' }
    ],
    answers: [['AB']],
    expect: ['B'],
    note: 'Order matters for option text'
  },
  {
    id: 'single-case',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: 'PH', dataValue: 'A' },
      { label: 'B', text: 'pH', dataValue: 'B' }
    ],
    answers: [['pH']],
    expect: ['B'],
    note: 'Case folding must not collapse two distinct options'
  },
  {
    id: 'single-decimal',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '314', dataValue: 'A' },
      { label: 'B', text: '3.14', dataValue: 'B' }
    ],
    answers: [['3.14']],
    expect: ['B'],
    note: 'Punctuation stripping merges 3.14 with 314'
  },
  {
    id: 'single-ambiguous-law',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '牛顿第一定律', dataValue: 'A' },
      { label: 'B', text: '牛顿第二定律', dataValue: 'B' }
    ],
    answers: [['牛顿定律']],
    expect: 'abstain',
    note: 'Both laws tie; selecting one is a guess'
  },
  {
    id: 'single-near-duplicate',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '光合作用', dataValue: 'A' },
      { label: 'B', text: '光合作用产物', dataValue: 'B' }
    ],
    answers: [['光合作用']],
    expect: ['A'],
    note: 'Exact option must win even when a longer option also contains it'
  },
  {
    id: 'single-remapped-letter',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '氧', dataValue: 'D' },
      { label: 'B', text: '氢', dataValue: 'C' },
      { label: 'C', text: '氮', dataValue: 'B' },
      { label: 'D', text: '氦', dataValue: 'A' }
    ],
    answers: [['C']],
    expect: ['C'],
    note: 'Letter answers resolve on the visible label, not the remapped data value'
  },
  {
    id: 'single-duplicate-label',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '甲', dataValue: 'A' },
      { label: 'A', text: '乙', dataValue: 'B' }
    ],
    answers: [['A']],
    expect: 'abstain',
    note: 'Two options claim label A; picking either is a coin flip'
  },
  {
    id: 'single-english-label-collision',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: 'Apple', dataValue: 'A' },
      { label: 'B', text: 'Banana', dataValue: 'B' }
    ],
    answers: [['B']],
    expect: ['B'],
    note: 'Single Latin letter must map to the option labelled B'
  },
  {
    id: 'single-letter-answer-without-any-visible-label',
    kind: 'single',
    mode: 'similar',
    options: [
      { text: 'Beta', dataValue: 'B' },
      { text: 'Alpha', dataValue: 'A' }
    ],
    answers: [['A']],
    expect: 'abstain',
    note: 'No option exposes a visible label; the letter must not be mapped by array position'
  },
  {
    id: 'single-empty-answer',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '甲', dataValue: 'A' },
      { label: 'B', text: '乙', dataValue: 'B' }
    ],
    answers: [['']],
    expect: 'abstain',
    note: 'Empty provider answer must not select anything'
  },
  {
    id: 'single-exact-mode-mismatch',
    kind: 'single',
    mode: 'exact',
    options: [
      { label: 'A', text: '甲方案', dataValue: 'A' },
      { label: 'B', text: '乙方案', dataValue: 'B' }
    ],
    answers: [['丙方案']],
    expect: 'abstain',
    note: 'Exact mode must not fall back to a fuzzy neighbour'
  },
  {
    id: 'single-exact-mode-primary',
    kind: 'single',
    mode: 'exact',
    options: [
      { label: 'A', text: '主要矛盾', dataValue: 'A' },
      { label: 'B', text: '次要矛盾', dataValue: 'B' }
    ],
    answers: [['主要矛盾']],
    expect: ['A'],
    note: 'Exact identity should be selected directly'
  },
  {
    id: 'single-two-groups-one-correct',
    kind: 'single',
    mode: 'similar',
    options: [
      { label: 'A', text: '甲烷', dataValue: 'A' },
      { label: 'B', text: '乙烷', dataValue: 'B' }
    ],
    answers: [['垃圾答案'], ['乙烷']],
    expect: ['B'],
    note: 'A junk provider group must not block the usable group'
  },
  {
    id: 'multiple-two-answers',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: '氧化', dataValue: 'A' },
      { label: 'B', text: '还原', dataValue: 'B' },
      { label: 'C', text: '中和', dataValue: 'C' },
      { label: 'D', text: '沉淀', dataValue: 'D' }
    ],
    answers: [['氧化#沉淀']],
    expect: ['A', 'D'],
    note: 'Two separated answers map to two options'
  },
  {
    id: 'multiple-answer-count-cap',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: 'ABCDE', dataValue: 'A' },
      { label: 'B', text: 'WXYZ', dataValue: 'B' },
      { label: 'C', text: 'ABCDEF', dataValue: 'C' }
    ],
    answers: [['ABCDE#WXYZ']],
    expect: ['A', 'B'],
    note: 'Selection must not exceed the number of returned answers'
  },
  {
    id: 'multiple-duplicate-answer',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: 'same', dataValue: 'A' },
      { label: 'B', text: 'same', dataValue: 'B' }
    ],
    answers: [['same#same']],
    expect: 'abstain',
    note: 'Identical option texts with repeated answers are unmappable'
  },
  {
    id: 'multiple-plain-letters',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: '钾', dataValue: 'A' },
      { label: 'B', text: '钠', dataValue: 'B' },
      { label: 'C', text: '镁', dataValue: 'C' }
    ],
    answers: [['AC']],
    expect: ['A', 'C'],
    note: 'Plain letter group resolves through visible labels'
  },
  {
    id: 'multiple-plain-letters-remapped',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: '钾', dataValue: 'C' },
      { label: 'B', text: '钠', dataValue: 'A' },
      { label: 'C', text: '镁', dataValue: 'B' }
    ],
    answers: [['BC']],
    expect: ['B', 'C'],
    note: 'Letter group must follow visible labels when data values are remapped'
  },
  {
    id: 'multiple-plain-label-text-collision',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: 'AC', dataValue: 'A' },
      { label: 'B', text: '钠', dataValue: 'B' },
      { label: 'C', text: '镁', dataValue: 'C' }
    ],
    answers: [['AC']],
    expect: ['A', 'C'],
    note: 'A multi-select label group takes precedence over a coincidental option text match'
  },
  {
    id: 'multiple-unlabelled-option-text-collision',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { text: 'AC', dataValue: 'A' },
      { text: '钠', dataValue: 'B' },
      { text: '镁', dataValue: 'C' }
    ],
    answers: [['AC']],
    expect: ['#0'],
    note: 'Without visible labels, an exact option text is not reinterpreted as a label set'
  },
  {
    id: 'multiple-conflicting-label-groups-abstain',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: 'AC', dataValue: 'A' },
      { label: 'B', text: '乙', dataValue: 'B' },
      { label: 'C', text: '丙', dataValue: 'C' },
      { label: 'D', text: '丁', dataValue: 'D' }
    ],
    answers: [['AC'], ['BD']],
    expect: 'abstain',
    note: 'Conflicting label sets from one source must not be merged or recovered by text similarity'
  },
  {
    id: 'multiple-partial-group',
    kind: 'multiple',
    mode: 'similar',
    options: [
      { label: 'A', text: '甲', dataValue: 'A' },
      { label: 'B', text: '乙', dataValue: 'B' },
      { label: 'C', text: '丙', dataValue: 'C' }
    ],
    answers: [['甲#丙#丁']],
    expect: 'abstain',
    note: 'One unmappable answer makes the whole group unsafe'
  },
  {
    id: 'multiple-exact-mode',
    kind: 'multiple',
    mode: 'exact',
    options: [
      { label: 'A', text: '动能', dataValue: 'A' },
      { label: 'B', text: '势能', dataValue: 'B' },
      { label: 'C', text: '内能', dataValue: 'C' }
    ],
    answers: [['动能#内能']],
    expect: ['A', 'C'],
    note: 'Exact multi-answer mapping'
  },
  {
    id: 'judgement-correct',
    kind: 'judgement',
    mode: 'similar',
    options: [
      { label: 'A', text: '正确', dataValue: 'A' },
      { label: 'B', text: '错误', dataValue: 'B' }
    ],
    answers: [['对']],
    expect: ['A'],
    note: 'Polarity words map to the visible option'
  },
  {
    id: 'judgement-incorrect',
    kind: 'judgement',
    mode: 'similar',
    options: [
      { label: 'A', text: '正确', dataValue: 'A' },
      { label: 'B', text: '错误', dataValue: 'B' }
    ],
    answers: [['×']],
    expect: ['B'],
    note: 'Cross mark maps to 错误'
  },
  {
    id: 'judgement-no-polarity-option',
    kind: 'judgement',
    mode: 'similar',
    options: [
      { label: 'A', text: '甲', dataValue: 'A' },
      { label: 'B', text: '乙', dataValue: 'B' }
    ],
    answers: [['对']],
    expect: 'abstain',
    note: 'No option carries polarity; guessing is wrong'
  },
  {
    id: 'completion-two-blanks',
    kind: 'completion',
    mode: 'similar',
    options: [
      { label: '', text: '', dataValue: '' },
      { label: '', text: '', dataValue: '' }
    ],
    answers: [['第一空#第二空']],
    expect: ['第一空', '第二空'],
    note: 'Blank order and literal text must be preserved'
  },
  {
    id: 'completion-angle-brackets',
    kind: 'completion',
    mode: 'similar',
    options: [
      { label: '', text: '', dataValue: '' }
    ],
    answers: [['<T> 与 <E>']],
    expect: ['<T> 与 <E>'],
    note: 'Angle brackets are content, not markup'
  }
];

export default cases;
