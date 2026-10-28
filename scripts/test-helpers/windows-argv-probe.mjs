process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\n');
