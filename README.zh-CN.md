# Squoosh Tool

**中文** · [English](README.md)

基于 [Squoosh](https://github.com/GoogleChromeLabs/squoosh) 的桌面版图片压缩工具，支持 Windows 与 macOS。

所有压缩都在本机完成，图片不会上传或传输到任何服务器，可完全离线使用。

## 功能

- 支持 MozJPEG、WebP、AVIF、JPEG XL、OxiPNG、WP2、QOI 等编码格式
- 单图对比压缩：左右并排预览压缩前后效果
- 批量处理：一次导入多张图片，可选择多张图片或整个文件夹
- 可设置并发数与 CPU 占用上限
- 批量结果一键导出到指定文件夹
- 简体中文 / English 界面切换
- 完全离线运行，无任何统计上报

## 下载

前往 [Releases](https://github.com/evan-rio/squoosh-tool/releases) 下载，每个平台提供两种形式：

- **安装版** — 安装到系统，带开始菜单 / 应用程序入口，可正常卸载
- **便携版** — 解压即用，不写入系统、无需安装

| 平台 | 安装版 | 便携版 |
| --- | --- | --- |
| Windows 64 位 | `SquooshTool-<版本>-windows-x64-setup.exe` | `SquooshTool-<版本>-windows-x64-portable.zip` |
| macOS（Apple Silicon） | `SquooshTool-<版本>-macos-apple-silicon.dmg` | `SquooshTool-<版本>-macos-apple-silicon-portable.zip` |
| macOS（Intel） | `SquooshTool-<版本>-macos-intel.dmg` | `SquooshTool-<版本>-macos-intel-portable.zip` |

### 安装说明

- **Windows** — 运行安装程序即可。若系统缺少 WebView2 运行时，安装过程会自动下载（Windows 10 1803 以上及 Windows 11 通常已内置）。便携版解压后直接运行 `squoosh-tool.exe`。
- **macOS** — 安装包**未做代码签名**，首次打开时系统会提示「无法验证开发者」。请右键点击应用选择「打开」，或在终端执行：

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Squoosh Tool.app"
  ```

  只需放行一次，之后即可正常使用。

## 免责声明

本项目为第三方衍生版本，与 Google 及 Google Chrome Labs 无任何关联，也未获得其赞助或背书。软件按「现状」提供，不附带任何担保。使用前请阅读 [DISCLAIMER.zh-CN.md](DISCLAIMER.zh-CN.md)。

## 许可

本项目采用 Apache-2.0 许可，详见 [LICENSE](LICENSE)。原始版权归 Google LLC 及 Squoosh 贡献者所有。
