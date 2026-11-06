# Shopify SEO 工具包

当前版本 **0.17.0**。以 Shopify 主题代码为输入，检查并修复元数据、JSON-LD、链接与图片替代文本问题，提供计划、写入、回滚和源码复核。

这是源码发行包，需要 Node.js 22.19+；HTML 检查使用 Python 3.9+ 标准库。修复使用锁定版本的 Shopify Liquid 解析器，不需要安装 Lighthouse、Chrome 或另一个性能工具包。

## 安装与运行

解压 `shopify-seo-toolkit-v0.17.0.zip` 后，在解压目录执行：

```sh
npm ci --ignore-scripts
node scripts/seokit.mjs doctor
node scripts/seokit.mjs audit-source --project /absolute/theme --out /absolute/task/source-seo.json
node scripts/seokit.mjs fix --project /absolute/theme --out /absolute/task/new-fix
npm test
```

需要系统命令时，可执行 `npm install --global --ignore-scripts /absolute/shopify-seo-toolkit`，之后使用 `seokit`。需要 Codex 技能入口时，将完整解压目录放到个人技能目录下的 `shopify-seo-toolkit`，或从该名称建立软链接；保留包内 scripts、lib 和 references。无需修改性能工具的安装入口。

批处理复制 [配置示例](../../assets/examples/seo-batch.json) 并填入实际路径，再执行 `node scripts/seokit.mjs batch --config /absolute/seo-batch.json --out /absolute/new-run`。仓库开发者从根目录运行脚本；`packages/seo` 是发行清单和文档模板，独立安装使用生成的 ZIP。

## 结果含义

`audit-complete` 表示这次离线规则执行完整且无发现；`review-required` 表示有条目待审，`partial` 表示覆盖不完整。批次另有 `failed` / `stopped`。只读审查结果保留 `acceptance=not-evaluated`，不声称线上 SEO、排名或性能验收通过。

`fix` 会真实修改主题文件，保存计划与回滚快照，失败会尝试还原；`source-fix-verified` 仅代表选定源码规则已修复。`partially-repaired` 列出剩余问题，Codex 可按已有业务数据提供 `--config` 候选继续修复。详见 [完整修复流程](../../references/source-repair-workflow.md)。保存 HTML 检查仍可选，不参与源码修复验收。HTML 行号不等于 Liquid 行号；原始字节指纹不证明当前店铺或部署。完整页面与 Section 片段采用不同检查范围。

可选 PDF：在选用的 Python 环境安装 reportlab 后，执行 `node scripts/seokit.mjs report-pdf --input /absolute/task/html-seo.json --out /absolute/task/seo.pdf`。`SEOKIT_PYTHON` 可选择解释器，也兼容 `PERF_KIT_PYTHON`。PDF 不是基本安装或审查的必需依赖。

[完整配置与证据边界](../../references/seo-toolkit.md) · [更新记录](CHANGELOG.md) · [第三方许可](../../THIRD_PARTY_NOTICES.md)
