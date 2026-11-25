name: ai-council-schedule

on:
  schedule:
    # 한국시간(KST, UTC+9) 매시 30분 == UTC 매시 30분
    - cron: "30 * * * *"
  workflow_dispatch:
    inputs:
      issue_number:
        description: "협업 대상 GitHub 이슈 번호"
        required: false
        default: "724"
        type: string
      task_id:
        description: "작업 번호 (비워두면 KST-YYYYMMDD-HH30 자동 생성)"
        required: false
        default: ""
        type: string
      base_branch:
        description: "기준 브랜치 (최신 커밋 SHA 조회용)"
        required: false
        default: "main"
        type: string
      provider_mode:
        description: "실행 AI 범위 (multi 또는 gemini_only)"
        required: false
        default: "multi"
        type: choice
        options:
          - multi
          - gemini_only
      dry_run:
        description: "댓글을 실제로 게시하지 않고 실행 로그만 점검"
        required: false
        default: false
        type: boolean

permissions:
  issues: write
  contents: read
  pull-requests: read
  checks: read

concurrency:
  group: ai-issue-council-${{ inputs.issue_number || '724' }}
  cancel-in-progress: false

jobs:
  council-hourly:
    name: Hourly Multi-AI Issue #724 Council (KST :30)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout repository (read-only)
        uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Setup Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Resolve KST hourly task ID
        id: meta
        env:
          INPUT_TASK_ID: ${{ inputs.task_id }}
        run: |
          if [ -n "$INPUT_TASK_ID" ]; then
            TASK_ID="$INPUT_TASK_ID"
          else
            TASK_ID="$(TZ=Asia/Seoul date +'KST-%Y%m%d-%H30')"
          fi
          echo "task_id=$TASK_ID" >> "$GITHUB_OUTPUT"

      - name: Run Multi-AI Issue Council (R1 -> R2)
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          ISSUE_NUMBER: ${{ inputs.issue_number || '724' }}
          TASK_ID: ${{ steps.meta.outputs.task_id }}
          BASE_BRANCH: ${{ inputs.base_branch || 'main' }}
          DRY_RUN: ${{ inputs.dry_run || 'false' }}
          PROVIDER_MODE: ${{ inputs.provider_mode || 'multi' }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GEMINI_MODEL: ${{ vars.GEMINI_MODEL || 'gemini-3.8-flash' }}
          OPENAI_MODEL: ${{ vars.OPENAI_MODEL || 'gpt-4.1-mini' }}
          ANTHROPIC_MODEL: ${{ vars.ANTHROPIC_MODEL || '' }}
        run: node scripts/ai-issue-council.mjs
