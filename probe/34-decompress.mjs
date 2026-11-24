// 用流式解压处理多帧 zstd 会话日志
import { createReadStream, writeFileSync } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

const SRC = process.argv[2]
const DST = process.argv[3]

try {
  await pipeline(createReadStream(SRC), createZstdDecompress(), createWriteStream(DST))
  const { statSync } = await import('node:fs')
  console.log('解压成功:', statSync(DST).size, '字节')
} catch (e) {
  console.log('流式失败:', e.message)
  // 退回：手工逐帧，用 zstdDecompressSync 试每个偏移
}
