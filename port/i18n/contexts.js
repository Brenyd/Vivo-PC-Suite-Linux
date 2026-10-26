// Places where a string literal is user-visible text (never logic): Vue template text nodes,
// display attributes, and toast/message calls. Only double-quoted literals (minified output).
const S = '"(?<s>(?:[^"\\\\]|\\\\.)*)"';
module.exports = [
  new RegExp(`_v\\(${S}\\)`, 'g'),
  new RegExp(`(?<![\\w$.])(?:placeholder|title|label|content|text|message|desc|description|tip|tips|okText|cancelText|confirmText|confirmButtonText|cancelButtonText|btnText|subTitle|subtitle|detail|buttons|emptyText|noDataText)\\s*:\\s*${S}`, 'g'),
  new RegExp(`\\.(?:\\$toast|toast|showToast|\\$message|\\$notify|\\$alert|\\$confirm)\\(${S}`, 'g'),
];
