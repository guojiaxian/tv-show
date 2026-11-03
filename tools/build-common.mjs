/**
 * 构建脚本公共部分：读文件、脚本内联转义、模板占位符替换与校验。
 * 供 build-client / build-pages 复用，避免每个页面各写一套替换逻辑。
 */
import { readFileSync } from 'node:fs';

export const read = (path) => readFileSync(path, 'utf8');

/** 内联进 <script> 文本节点时，只需转义可以提前结束标签的 "</" */
export const inlineScript = (text) => text.replace(/<\/(script)/gi, '<\\/$1');

/**
 * 逐个替换模板占位符，并确认每个占位符都已被替换。
 * 只校验本次声明的键：模板/内联脚本里可能存在业务用的双下划线标识，不能全量匹配。
 */
export function renderTemplate(templatePath, replacements, label) {
  let html = read(templatePath);
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(key, () => value);
  }
  for (const key of Object.keys(replacements)) {
    if (html.includes(key)) throw new Error(`${label || templatePath} 占位符未被全部替换：${key}`);
  }
  return html;
}
