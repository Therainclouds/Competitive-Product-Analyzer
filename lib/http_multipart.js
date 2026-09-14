/**
 * 零依赖 multipart/form-data 解析器
 * ------------------------------------------------------------
 * 仅用于工作台小文件上传（≤5MB），支持单文件 + 普通字段。
 * 解析失败抛 Error，调用方捕获。
 *
 * 使用：
 *   const { fields, files } = await parseMultipart(req);
 *   fields['userIdea']; // string
 *   files[0];           // { name, type, content: Buffer }
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * 解析 multipart/form-data 请求
 * @param {http.IncomingMessage} req
 * @returns {Promise<{fields: object, files: Array}>}
 */
async function parseMultipart(req) {
  const ctype = req.headers['content-type'] || '';
  const m = ctype.match(/^multipart\/form-data;\s*boundary=(.+)$/i);
  if (!m) throw new Error('Content-Type 必须是 multipart/form-data');
  const boundary = '--' + m[1];

  // 读取 body 到 Buffer（限制大小）
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_TOTAL_SIZE) {
      req.destroy();
      throw new Error(`请求体超过 ${MAX_TOTAL_SIZE / 1024 / 1024}MB`);
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  const fields = {};
  const files = [];

  // 按 boundary 切片
  const parts = splitBuffer(body, Buffer.from(boundary));
  for (const part of parts) {
    if (!part || part.length < 4) continue;
    // 第一个 part 以 \r\n 开头，最后一个以 -- 结尾，过滤掉
    // 每个 part 格式：
    //   \r\nContent-Disposition: form-data; name="xxx"[; filename="yyy"]\r\nContent-Type: ...\r\n\r\n<content>\r\n
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf8');
    let content = part.slice(headerEnd + 4);
    // 去掉末尾的 \r\n
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.slice(0, -2);
    }

    const cd = parseContentDisposition(headerStr);
    if (!cd.name) continue;

    if (cd.filename) {
      // file
      if (content.length > MAX_FILE_SIZE) {
        throw new Error(`文件 ${cd.filename} 超过 ${MAX_FILE_SIZE / 1024 / 1024}MB`);
      }
      files.push({
        name: cd.filename,
        type: (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1]?.trim() || 'application/octet-stream',
        content,
      });
    } else {
      // field
      fields[cd.name] = content.toString('utf8');
    }
  }

  return { fields, files };
}

function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(sep, start)) >= 0) {
    if (idx > start) parts.push(buf.slice(start, idx));
    start = idx + sep.length;
    // 跳过紧跟的 \r\n
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
  }
  if (start < buf.length) parts.push(buf.slice(start));
  return parts;
}

function parseContentDisposition(headerStr) {
  const cdLine = (headerStr.match(/Content-Disposition:\s*([^\r\n]+)/i) || [])[1] || '';
  const name = (cdLine.match(/name="([^"]+)"/i) || [])[1];
  const filename = (cdLine.match(/filename="([^"]+)"/i) || [])[1];
  return { name, filename };
}

/**
 * 简易文本提取器（仅支持纯文本类 + 基础二进制）
 * - txt / md / json / csv / html：按 UTF-8 读
 * - 其他（pdf/docx/doc）：返回 null，调用方需告知用户改用纯文本
 */
function extractTextFromFile(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  const isText =
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    /\.(txt|md|markdown|json|csv|tsv|html|htm|log|yaml|yml)$/.test(name);

  if (!isText) {
    return { ok: false, reason: `暂不支持解析 ${file.type || file.name}（仅支持 txt/md/json/csv/html 等纯文本）。请把 BP 内容复制粘贴到输入框。` };
  }
  const text = file.content.toString('utf8').replace(/^\uFEFF/, ''); // 去 BOM
  // 截断：超 8000 字截短（避免 LLM prompt 超长）
  const truncated = text.length > 8000;
  return { ok: true, text: truncated ? text.slice(0, 8000) + '\n\n[文件已截断，原文 ' + text.length + ' 字]' : text, truncated };
}

module.exports = { parseMultipart, extractTextFromFile };