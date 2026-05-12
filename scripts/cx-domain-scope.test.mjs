import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cxPath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');

const removedDomains = [
  'edu.cn',
  'org.cn',
  'xueyinonline.com',
  'hnsyu.net',
  'qutjxjy.cn',
  'ynny.cn',
  'hnvist.cn',
  'fjlecb.cn',
  'gdhkmooc.com',
  'cugbonline.cn',
  'zjelib.cn',
  'cqrspx.cn',
  'neauce.com',
  'zhihui-yun.com',
  'cqie.cn',
  'ccqmxx.com',
  'jxgmxy.com',
  'jnzyjsxy.cn',
  'sslibrary.com'
];

test('cx project domains only keep the official chaoxing domain', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.match(source, /domains:\s*\[\s*'chaoxing\.com'\s*\],/);
  removedDomains.forEach((domain) => {
    assert.equal(source.includes(`'${domain}'`), false);
  });
});
