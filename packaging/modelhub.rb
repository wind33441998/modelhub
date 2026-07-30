# ModelHub Homebrew formula (tap)
# ------------------------------------------------------------
# 安装：
#   brew tap wind33441998/modelhub
#   brew install modelhub
#
# 该 formula 从 GitHub Releases 拉取预编译二进制 modelhub-cli。
# ⚠️ 前置条件：release v1.2.0 的 modelhub-cli 必须是 macOS 通用/arm64 二进制。
#    当前该 asset 是否真的是 Mac 构建尚未在真机验证（见下方 TODO），上架前请确认。
# ⚠️ sha256 必须替换为真实值：
#    brew fetch modelhub.rb   # 或下载后用 `shasum -a 256 modelhub-cli`
class Modelhub < Formula
  desc "Local multi-model gateway proxy for Claude Code / Codex (Anthropic<->OpenAI)"
  homepage "https://claude-proxys.com"
  version "1.2.0"

  on_macos do
    on_arm do
      url "https://github.com/wind33441998/modelhub/releases/download/v1.2.0/modelhub-cli"
      # TODO: 替换为 modelhub-cli 在 macOS arm64 上的真实 sha256
      sha256 "REPLACE_WITH_REAL_SHA256_ARM64"
    end
    on_intel do
      url "https://github.com/wind33441998/modelhub/releases/download/v1.2.0/modelhub-cli"
      # TODO: 替换为 modelhub-cli 在 macOS x86_64 上的真实 sha256
      sha256 "REPLACE_WITH_REAL_SHA256_X86_64"
    end
  end

  def install
    # 二进制名为 modelhub-cli，安装为 `modelhub` 命令
    bin.install "modelhub-cli" => "modelhub"
  end

  # 可选：用 brew services 管理自启动（等价于 launchd plist）
  service do
    run [opt_bin/"modelhub"]
    keep_alive true
    log_path var/"log/modelhub.log"
    error_log_path var/"log/modelhub.err.log"
  end

  test do
    assert_match "ModelHub", shell_output("#{bin}/modelhub --version 2>&1")
  end
end
