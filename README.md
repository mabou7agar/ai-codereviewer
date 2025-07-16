# 🤖 AI Code Reviewer

[![GitHub Stars](https://img.shields.io/github/stars/your-username/ai-codereviewer?style=flat-square)](https://github.com/your-username/ai-codereviewer)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-Compatible-green?style=flat-square)](https://github.com/features/actions)

AI Code Reviewer is a powerful GitHub Action that leverages cutting-edge AI models to provide intelligent, automated code reviews on your pull requests. Save time, improve code quality, and catch issues early with AI-powered insights.

## ✨ Features

- 🧠 **Multi-Model Support**: Works with OpenAI GPT models and 100+ models via OpenRouter
- 🎯 **Intelligent Reviews**: Provides contextual feedback on code quality, bugs, and improvements  
- 🔄 **Resume Capability**: Handles large PRs with progress tracking and resume functionality
- 📁 **Smart Filtering**: Excludes specified file patterns from review
- 👤 **Personal Attribution**: Reviews appear under your name (not as a bot)
- 🚀 **High Performance**: Processes files individually to handle large PRs efficiently
- 🛡️ **Error Resilient**: Robust error handling and fallback mechanisms
- 🧪 **Local Testing**: Built-in local testing mode for development

## 🚀 Quick Start

### 1. Choose Your AI Provider

#### Option A: OpenRouter (Recommended)
- More models available (DeepSeek, Claude, Gemini, etc.)
- Often more cost-effective
- Sign up at [OpenRouter](https://openrouter.ai/)

#### Option B: OpenAI Direct
- Direct access to GPT models
- Sign up at [OpenAI](https://platform.openai.com/)

### 2. Set Up Repository Secrets

Go to your repository → Settings → Secrets and variables → Actions, then add:

**For Personal Attribution (Recommended):**
- `PERSONAL_GITHUB_TOKEN`: Your personal access token with `repo` and `pull_requests` scopes

**For AI Provider:**
- `OPENROUTER_API_KEY`: Your OpenRouter API key, OR
- `OPENAI_API_KEY`: Your OpenAI API key

### 3. Create Workflow File

Create `.github/workflows/ai-code-review.yml`:

```yaml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]
permissions: write-all

jobs:
  ai-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        
      - name: AI Code Review
        uses: your-username/ai-codereviewer@main
        with:
          # Use personal token for reviews under your name
          GITHUB_TOKEN: ${{ secrets.PERSONAL_GITHUB_TOKEN }}
          
          # OpenRouter (recommended)
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          OPENROUTER_API_MODEL: "deepseek/deepseek-chat-v3-0324"
          
          # OR OpenAI Direct
          # OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          # OPENAI_API_MODEL: "gpt-4"
          
          # Optional: exclude files
          exclude: "*.md,*.json,dist/**,node_modules/**"
```

## 🎛️ Configuration Options

### Input Parameters

| Parameter | Description | Required | Default |
|-----------|-------------|----------|---------|
| `GITHUB_TOKEN` | GitHub token for API access | ✅ | - |
| `OPENROUTER_API_KEY` | OpenRouter API key | ⚠️* | - |
| `OPENROUTER_API_MODEL` | OpenRouter model name | ❌ | `deepseek/deepseek-chat-v3-0324` |
| `OPENROUTER_BASE_URL` | OpenRouter API base URL | ❌ | `https://openrouter.ai/api/v1` |
| `OPENAI_API_KEY` | OpenAI API key | ⚠️* | - |
| `OPENAI_API_MODEL` | OpenAI model name | ❌ | `gpt-4` |
| `exclude` | File patterns to exclude | ❌ | `""` |

*Either OpenRouter or OpenAI credentials required

### Recommended Models

#### OpenRouter Models (Cost-Effective)
```yaml
# Best Performance/Cost Ratio
OPENROUTER_API_MODEL: "deepseek/deepseek-chat-v3-0324"

# High Quality Options
OPENROUTER_API_MODEL: "anthropic/claude-3-sonnet"
OPENROUTER_API_MODEL: "google/gemini-2.0-flash-exp"
OPENROUTER_API_MODEL: "meta-llama/llama-3.1-70b-instruct"
```

#### OpenAI Models
```yaml
OPENAI_API_MODEL: "gpt-4o"           # Latest GPT-4
OPENAI_API_MODEL: "gpt-4o-mini"     # Cost-effective
OPENAI_API_MODEL: "gpt-4-turbo"     # High performance
```

## 🔧 Advanced Setup

### Personal Token Setup (For Reviews Under Your Name)

1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Generate new token with scopes:
   - `repo` (Full control of private repositories)
   - `pull_requests` (Access pull requests)
3. Add as `PERSONAL_GITHUB_TOKEN` secret in your repository

### File Exclusion Patterns

```yaml
# Exclude specific files and directories
exclude: "*.md,*.json,package-lock.json,yarn.lock,dist/**,build/**,node_modules/**"

# Exclude test files
exclude: "**/*.test.js,**/*.spec.ts,__tests__/**"

# Exclude generated files
exclude: "*.generated.*,**/generated/**,**/*.min.js"
```

## 🧪 Local Testing

For development and testing:

1. Clone the repository
2. Copy `.env.example` to `.env` and configure:
   ```bash
   GITHUB_TOKEN=your_github_token
   OPENROUTER_API_KEY=your_openrouter_key
   GITHUB_REPOSITORY=owner/repo
   PR_NUMBER=123
   ```
3. Run local test:
   ```bash
   npm install
   npm run build
   node quick-test.js
   ```

## 📊 How It Works

1. **Trigger**: Action runs on PR open/update
2. **Fetch**: Retrieves PR diff and file changes
3. **Filter**: Applies exclusion patterns
4. **Process**: Sends code chunks to AI model
5. **Review**: AI analyzes code for:
   - Bugs and potential issues
   - Code quality improvements
   - Best practice suggestions
   - Security vulnerabilities
6. **Comment**: Posts review comments on specific lines

## 🔍 Features Deep Dive

### Large PR Support
- **Progress Tracking**: Saves progress for large PRs
- **Resume Capability**: Continues from where it left off
- **Batch Processing**: Handles files in manageable batches
- **Memory Efficient**: Processes files individually

### Error Handling
- **Response Format Detection**: Handles various AI model response formats
- **JSON Parsing**: Robust parsing with multiple fallbacks
- **Rate Limit Handling**: Automatic retry with backoff
- **Partial Response Recovery**: Extracts useful content from truncated responses

### Model Compatibility
- **OpenAI Models**: GPT-3.5, GPT-4, GPT-4 Turbo
- **Anthropic Models**: Claude 3 (Opus, Sonnet, Haiku)
- **Google Models**: Gemini Pro, Gemini Flash
- **Meta Models**: Llama 3.1 series
- **DeepSeek Models**: DeepSeek Chat v3
- **And 100+ more via OpenRouter**

## 🛠️ Troubleshooting

### Common Issues

**Reviews appear as "github-actions[bot]"**
- Use `PERSONAL_GITHUB_TOKEN` instead of `GITHUB_TOKEN`

**JSON parsing errors**
- Usually resolved automatically with built-in fallbacks
- Check model compatibility

**Rate limiting**
- Built-in retry mechanism handles this automatically
- Consider using OpenRouter for higher limits

**Large PR timeouts**
- Progress is automatically saved and resumed
- Use file exclusion patterns to reduce scope

### Debug Mode

Enable detailed logging by setting environment variable:
```yaml
env:
  DEBUG: "true"
```

## 📈 Performance Tips

1. **Use Exclusion Patterns**: Skip unnecessary files
2. **Choose Efficient Models**: DeepSeek offers great performance/cost ratio
3. **OpenRouter Benefits**: Often faster and cheaper than direct OpenAI
4. **Batch Size**: Automatically optimized for each model

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
```bash
git clone https://github.com/your-username/ai-codereviewer.git
cd ai-codereviewer
npm install
npm run build
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- OpenAI for GPT models
- OpenRouter for multi-model access
- GitHub Actions platform
- All contributors and users

---

**Made with ❤️ for better code reviews**

*Star ⭐ this repo if you find it useful!*
