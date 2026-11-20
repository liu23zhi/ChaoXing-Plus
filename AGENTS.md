# Agent 协作约定

## 关联仓库

三个仓库在同一父目录下，分别管理代码与文档：

| 仓库 | 相对位置 | 职责 |
| --- | --- | --- |
| chaoxing_plus | `.` | 调用题库服务的扩展与客户端 |
| TiKuHelper（本地目录仍为 `tikuAdapter`） | `../tikuAdapter/` | 题库服务端、管理界面与接口 |
| TikuDoc | `../TikuDoc/` | 两个代码仓库的统一文档 |

涉及接口或跨端行为时，同时检查关联仓库的实现与兼容性；三个仓库各自维护 Git 状态和提交。

## 文档统一存放

- 设计、规格、实施计划、排查记录、验证报告、任务清单和跨轮次记录统一写入 `../TikuDoc/`，不要在本仓库新建这些文档或恢复 `docs/`、`tasks/` 文档目录。
- 本仓库的文档路径按原目录映射：原 `docs/<文件>` 对应 `../TikuDoc/chaoxing_plus/docs/<文件>`；原 `tasks/<文件>` 对应 `../TikuDoc/chaoxing_plus/tasks/<文件>`。
- 当前开发清单入口为 `../TikuDoc/chaoxing_plus/TASKLIST.md`；文档维护规则见 `../TikuDoc/README.md`。
- 技能默认要求生成 `docs/superpowers/specs/` 或 `docs/superpowers/plans/` 时，分别写入 `../TikuDoc/chaoxing_plus/docs/superpowers/specs/` 与 `../TikuDoc/chaoxing_plus/docs/superpowers/plans/`，并在 TikuDoc 仓库提交。TiKuHelper 在 TikuDoc 中沿用历史归档目录名 `tikuAdapter/`。
- 本文件与随代码维护的 README 等目录说明可以保留在代码仓库；它们不作为设计、计划或验证文档的替代存放位置。

## 路径与协作

- 仓库说明和新增文档中的本地路径一律使用相对路径，不写绑定个人机器的绝对路径。
- 引用实现时标明仓库、仓库内路径和函数或组件名；跨仓库文件链接使用兄弟仓库的相对路径。
- 修改前检查相关仓库的工作区，保留已有改动；完成后分别验证并创建中文本地提交。未经用户要求，不推送、不重写历史。
