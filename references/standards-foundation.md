# 规范对齐第一批：参考映射与证据状态

本文件记录第一批的兼容边界。后续第二、三批已新增 opt-in 策略与八项检测，当前 39 项映射及新入口见 [规范对齐扩展](standards-upgrade.md)。

本批保持现有 CLI、默认 score 目标、五次正式采样、部署身份、业务/视觉和回滚门禁。没有启用新的规范验收策略，也没有新增自动修复器。

## CrUX 阈值观察

`import-field` 保留既有 `status: limited`、`samples: null` 和 `sample-count-unavailable`，新增分组 `assessment`：

- `thresholdEligible`：当前指标可用于阈值观察。未过期的 CrUX 聚合 p75 不因样本总数未提供而被排除。
- `sampleCountKnown`：是否提供了样本总数，不推测或填充 CrUX 的样本量。
- `trendEligible`：沿用原样本与时效条件；样本未知仍不能获得可比趋势结论。
- `releaseAttribution`：保持 `not-established`。阈值观察不是发布因果收益。

`field-monitor` 的阈值告警保留 URL/Origin、设备、窗口、p75 和样本量信息。过期数据、发布混合窗口和样本不足继续保持原来的限制；重叠窗口不能形成趋势结论。普通 RUM 缺少样本数时仍受原限制。所有派生字段在导入时重新计算，不信任保存报告中的状态标志。

`diagnose-performance` 可用合格的 CrUX 阈值观察提高相应指标候选的优先级；`affectedSamples` 仍可为 null。Origin 数据只是该来源范围的线索，不证明某个 URL 或交互元素实际超标。

## 四态检查结果

`verify-optimization` 在原 `checks[].pass`、`outcome` 外增加 `checkResults`，状态为 `PASS`、`FAIL`、`NOT RUN`、`N/A`。原布尔判定仍决定是否验收；缺少必需证据不会因此通过。

`gateStates` 保留 passed/failed 的旧布尔结果，增加 `checkStatus` 与 `reason`。明确未执行或未启用的检查为 `NOT RUN` / `not-assessed`，不再标记已执行。只有 `applicable: false` 且提供理由才能产生 `N/A`；没有执行信息不是不适用。

正式验收中缺少场景、视觉审阅或完整性证据时会明确标为未运行；旧流程未启用的可选完整性门禁仍不改变旧验收结果。数据已提交但验证不符仍保留失败结论。四态适配是报告层，不把候选、采集进度、流程状态混成规则符合结果。

## 规范登记与内部编号

`assets/standards/registry-v1.json` 固定了 2026-11-11 的规范 1.0 元数据，共 130 条。记录规则标题、级别、依据、责任、证据要求、检查说明、执行建议、原文件/行号和原文件 SHA-256。来源仍为待评审草案，执行档位仍是建议：`enforcement: reference-only`。

`lib/standards-registry.mjs` 维护现有 31 项性能检测的多对多关联。原 `ruleId` 保持不变，性能扫描/审计及完整性问题新增 `standardRuleIds`；审计报告另记录规范版本、映射版本和登记文件哈希。

可在工具根目录查询登记表：

```sh
node --input-type=module -e "import {standardsCatalog} from './lib/standards-registry.mjs'; console.log(JSON.stringify(standardsCatalog(), null, 2))"
```

`relatedInternalRules` 表示相关候选检查，不表示整条规范的自动覆盖。未关联规则仍保留在目录中，`assessment` 为 `not-assessed`；映射不改变问题的 candidate/review-required 状态，也不代表通过。

登记表随 package.files 的 assets/lib 自动发行，运行时不读取 Downloads 或联网。更新时从规范正文与执行表重新核对元数据、更新来源指纹，并审阅内部映射；不能只增加编号就宣称实现了新规则。第一批没有将 SEO、人工流程或治理规则变成新的检测器。

## 验证

针对性测试：`node --test tests/standards-foundation.test.mjs tests/p0-p1.test.mjs tests/delivery-foundation.test.mjs tests/delivery-growth.test.mjs tests/p1-performance.test.mjs tests/formal-runtime-integrity.test.mjs`。

测试覆盖 CrUX 告警与持久化、未知计数、过期/混合/重叠窗口、派生状态重算、四态反例、旧正式验收、全部规则引用、报告兼容及发行清单。均为隔离夹具，不代表真实店铺性能已验收。
