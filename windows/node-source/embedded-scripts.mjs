function quotePowerShell(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

// Embedded scripts use an encoded ScriptBlock so runtime helpers need no files.
export function buildPowerShellScriptArgs(name, scriptPath, {
  defaultScriptPath = scriptPath,
  parameters = []
} = {}) {
  const flatArguments = [];
  const commandArguments = [];
  for (const [parameter, value] of parameters) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(parameter)) throw new TypeError(`Invalid PowerShell parameter: ${parameter}`);
    if (value === false || value === undefined || value === null) continue;
    flatArguments.push(`-${parameter}`);
    commandArguments.push(`-${parameter}`);
    if (value !== true) {
      flatArguments.push(String(value));
      commandArguments.push(quotePowerShell(value));
    }
  }
  const scripts = globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__;
  const source = scriptPath === defaultScriptPath && scripts && scripts[name];
  if (!source) return ['-File', scriptPath, ...flatArguments];
  const invocation = '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); '
    + '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); '
    + `$ProgressPreference = 'SilentlyContinue'; & {\n${source}\n}`;
  const command = [invocation, ...commandArguments].join(' ');
  return ['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
}
