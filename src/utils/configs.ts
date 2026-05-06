export const playbackRate = {
  label: '视频倍速',
  options: [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 6, 8, 16].map((rate) => [rate.toString(), `${rate} x`] as [string, string]),
  defaultValue: '1'
};

export const volume = {
  label: '音量调节',
  defaultValue: 0
};

export const workNotes = {
  defaultValue: '自动答题前请先配置题库。'
};

export const dropdownStyle = {
  labelClassName: 'checkbox-label',
  providerClassName: 'checkbox-input'
};
