# Dental Clinic Knowledge Base & AI Chat App

A web application for dental clinic staff to centrally manage internal documents and ask questions to an AI.  
Simply upload PDFs, Word files, or images — automatic OCR, AI summarization, and RAG-powered chat are available instantly.

---

## Screenshots

| AI Chat | AI Summary |
|---|---|
| ![AI Chat](./screenshots/chat.png) | ![AI Summary](./screenshots/summary.png) |

| Document Repository | Manual / Slide Generation |
|---|---|
| ![Repository](./screenshots/repository.png) | ![Manual Generation](./screenshots/manual.png) |

---

## Features

| Feature | Description |
|---|---|
| **Document Upload** | Store PDF / Word / images / videos to S3 |
| **Automatic OCR** | Extract text from scanned PDFs via AWS Textract |
| **AI Summarization** | AI generates concise summaries per chapter, section, and heading (≤400 chars each) |
| **RAG Chat** | AI answers questions by retrieving relevant content from Bedrock Knowledge Base |
| **Document-scoped Chat** | Filter specific documents and ask the AI targeted questions |
| **Manual Generation** | Generate Word-format manuals from AI chat output |

---

## Architecture

```
Browser (Next.js SSR on Amplify Hosting)
    │
    ├─ Upload ──────────→ Amazon S3
    │                         │
    │                   Amazon SQS Queue
    │                         │
    │                   Consumer Lambda
    │                         │
    │                   AWS Step Functions (Prepare)
    │                     ├─ OCR (AWS Textract)
    │                     └─ Bedrock Knowledge Base Sync
    │
    ├─ Summarize ───────→ AWS Step Functions (Summary)
    │                         └─ Lambda (chapter-by-chapter summary via Claude)
    │
    └─ AI Chat ─────────→ Amazon Bedrock (RetrieveAndGenerate)
                               └─ Bedrock Knowledge Base (RAG)
```

---

## Tech Stack

**Frontend**
- Next.js 15 (App Router / SSR)
- TypeScript

**Infrastructure / Backend**
- AWS Amplify Hosting (Git-integrated SSR deployment)
- Amazon S3 (documents, metadata, summaries)
- Amazon SQS (upload queue)
- AWS Lambda (OCR / summarization / KB sync workers)
- AWS Step Functions (processing workflows)
- Amazon Bedrock / Bedrock Knowledge Base (RAG + LLM)
- AWS Textract (OCR for scanned PDFs)

**Development**
- Claude Code (AI coding agent)

---

## Getting Started

### Prerequisites

- Node.js 24 LTS
- AWS CLI (with `dental-dev` profile configured)
- AWS account (with permissions for Bedrock, Textract, Lambda, S3)

### Local Development

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your actual AWS resource values

# Start development server
npm run dev
```

### Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|---|---|
| `S3_BUCKET_NAME` | S3 bucket for documents and metadata |
| `APP_TEXTRACT_BUCKET_NAME` | S3 bucket for Textract OCR input |
| `BEDROCK_KNOWLEDGE_BASE_ID` | Bedrock Knowledge Base ID |
| `BEDROCK_MODEL_ARN` | ARN of the Bedrock model to use |
| `APP_PREPARE_STATE_MACHINE_ARN` | ARN of the OCR + KB sync workflow |
| `APP_SUMMARY_STATE_MACHINE_ARN` | ARN of the summarization workflow |
| `PREPARE_QUEUE_URL` | SQS queue URL for upload processing |
| `APP_SHARE_PASSWORD` | Password for shared access authentication |
| `APP_AUTH_SECRET` | Secret key for session signing |

### Infrastructure Templates

JSON templates for IAM policies, Step Functions, and Bedrock configuration are in `infra/`.  
Replace `YOUR_ACCOUNT_ID` and other placeholders with your actual values before applying via AWS CLI.

---

## Deploying Lambda Functions

Lambda code is managed under `lambda/`. Changes are **not** deployed automatically by git push — each function must be deployed explicitly.

```bash
# Example: update summary_worker
Compress-Archive -LiteralPath .\lambda\summary_worker\handler.py -DestinationPath .\lambda\summary_worker_docai.zip -Force
aws lambda update-function-code --function-name dental-summary-worker-dev --zip-file fileb://lambda/summary_worker_docai.zip --profile dental-dev --region ap-northeast-1
Remove-Item -LiteralPath .\lambda\summary_worker_docai.zip -Force
```

Dependencies are managed via Lambda Layers, so only `handler.py` needs to be zipped and deployed.

---

## License

Private
