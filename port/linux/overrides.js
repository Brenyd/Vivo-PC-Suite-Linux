// Modules replaced with Linux implementations (loaded by linux-boot.js before vivo's code).
module.exports = {
  'electron-dragfile': require('./dragfile-linux.js'),
  'filesearch': require('./filesearch-linux.js'),
  'regedit': require('./regedit-linux.js'),
};
