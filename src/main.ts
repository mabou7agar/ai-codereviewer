import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff, { File as ParsedFile, Chunk } from "parse-diff";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { minimatch } from "minimatch";
import OpenAI from "openai";

// For local development, try to use environment variables if core.getInput fails
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN") || process.env.GITHUB_TOKEN || "";
const API_KEY: string =
  core.getInput("OPENROUTER_API_KEY") ||
  core.getInput("OPENAI_API_KEY") ||
  process.env.OPENROUTER_API_KEY ||
  process.env.OPENAI_API_KEY ||
  "";
const API_MODEL: string =
  core.getInput("OPENROUTER_API_MODEL") ||
  core.getInput("OPENAI_API_MODEL") ||
  process.env.OPENROUTER_API_MODEL ||
  process.env.OPENAI_API_MODEL ||
  "deepseek/deepseek-chat-v3-0324";
const API_BASE_URL: string =
  core.getInput("OPENROUTER_BASE_URL") ||
  process.env.OPENROUTER_BASE_URL ||
  "https://openrouter.ai/api/v1";

// Add validation for required credentials
if (!GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN is required but not provided");
}

if (!API_KEY) {
  throw new Error("Either OPENROUTER_API_KEY or OPENAI_API_KEY is required but not provided");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: API_KEY,
  baseURL: API_BASE_URL,
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/actions",
    "X-Title": "AI Code Reviewer",
  },
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface ReviewComment {
  body: string;
  path: string;
  line: number;
}

interface ReviewProgress {
  prNumber: number;
  repository: string;
  processedFiles: string[];
  allComments: ReviewComment[];
  currentBatch: number;
  totalFiles: number;
  timestamp: string;
  completed: boolean;
}

// Progress file management
const PROGRESS_FILE = 'ai-review-progress.json';

function loadProgress(): ReviewProgress | null {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const progressData = readFileSync(PROGRESS_FILE, 'utf8');
      return JSON.parse(progressData);
    }
  } catch (error) {
    logWarning(`Failed to load progress file: ${error}`);
  }
  return null;
}

function saveProgress(progress: ReviewProgress): void {
  try {
    writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    logInfo(`Progress saved: ${progress.processedFiles.length}/${progress.totalFiles} files processed`);
  } catch (error) {
    logError(`Failed to save progress: ${error}`);
  }
}

function clearProgress(): void {
  try {
    if (existsSync(PROGRESS_FILE)) {
      require('fs').unlinkSync(PROGRESS_FILE);
      logInfo("Progress file cleared");
    }
  } catch (error) {
    logWarning(`Failed to clear progress file: ${error}`);
  }
}

function createInitialProgress(prNumber: number, repository: string, totalFiles: number): ReviewProgress {
  return {
    prNumber,
    repository,
    processedFiles: [],
    allComments: [],
    currentBatch: 0,
    totalFiles,
    timestamp: new Date().toISOString(),
    completed: false
  };
}

async function getPRDetails(): Promise<PRDetails> {
  try {
    // Check if PR_NUMBER is provided as input (for manual workflow dispatch)
    const manualPRNumber = core.getInput("PR_NUMBER");
    logInfo(`Manual PR_NUMBER input: '${manualPRNumber}' (length: ${manualPRNumber.length})`);
    
    logInfo("Reading event data from: " + (process.env.GITHUB_EVENT_PATH || "undefined"));
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
    );
    
    // Use manual PR number if provided, otherwise use event data
    let prNumber: number;
    if (manualPRNumber && manualPRNumber.trim()) {
      prNumber = parseInt(manualPRNumber, 10);
      logInfo(`Using manual PR number: ${prNumber}`);
      
      // Validate the parsed number
      if (isNaN(prNumber) || prNumber <= 0) {
        throw new Error(`Invalid PR number provided: ${manualPRNumber}`);
      }
    } else if (eventData.number) {
      prNumber = eventData.number;
      logInfo(`Using event PR number: ${prNumber}`);
    } else if (eventData.pull_request?.number) {
      // Fallback to pull_request.number if available
      prNumber = eventData.pull_request.number;
      logInfo(`Using pull_request PR number: ${prNumber}`);
    } else {
      throw new Error("No PR number found in manual input or event data. For manual workflow dispatch, please provide PR_NUMBER input.");
    }
    
    const repository = eventData.repository;
    
    if (!repository?.owner?.login || !repository?.name) {
      throw new Error("Repository information not found in event data");
    }
    
    logInfo(`Event data: repository=${repository.owner.login}/${repository.name}, PR number=${prNumber} ${manualPRNumber ? '(manual)' : '(from event)'}`);

    logInfo(`Fetching PR details for ${repository.owner.login}/${repository.name}#${prNumber}`);
    const prResponse = await octokit.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
    });
    logInfo(`PR details fetched successfully: title=${prResponse.data.title}, description=${prResponse.data.body}`);
    return {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: prNumber,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
    };
  } catch (error) {
    logError(`Error fetching PR details: ${error}`);
    throw error;
  }
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  try {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });
    // @ts-expect-error - response.data is a string
    return response.data;
  } catch (error: any) {
    // Check if the error is due to diff size limitation
    const errorResponse = error.response;

    if (
      // Check for the specific 406 status code error format
      (errorResponse?.status === 406 &&
       errorResponse?.data?.message?.includes("maximum number of lines")) ||
      // Also check the error message directly (fallback for other error formats)
      (error.message && error.message.includes("maximum number of lines"))
    ) {
      logInfo("Diff too large (exceeds 20,000 lines). Fetching files individually...");
      return await getIndividualFileDiffs(owner, repo, pull_number);
    }

    // Re-throw any other errors
    logError(`Error fetching diff: ${error}`);
    throw error;
  }
}

async function getIndividualFileDiffs(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string> {
  logInfo(`API_BASE_URL: ${API_BASE_URL}`)

  const repository = `${owner}/${repo}`;

  // Check for existing progress
  let progress = loadProgress();
  const shouldResume = progress &&
    progress.prNumber === pull_number &&
    progress.repository === repository &&
    !progress.completed;

  if (shouldResume && progress) {
    logInfo(`📋 Resuming from previous session: ${progress.processedFiles.length}/${progress.totalFiles} files already processed`);
    logInfo(`⏰ Previous session started: ${progress.timestamp}`);
  } else {
    logInfo("🚀 Starting fresh review session");
    if (progress) {
      clearProgress(); // Clear old progress for different PR
    }
  }

  try {
    // Get list of files changed in the PR
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: 100, // Adjust as needed
    });

    logInfo(`Found ${files.length} files to analyze individually`);

    if (files.length === 0) {
      logWarning("No files were found in the pull request.");
      return "";
    }

    // Initialize or update progress
    if (!shouldResume || !progress) {
      progress = createInitialProgress(pull_number, repository, files.length);
    }

    // For testing purposes, limit to 1 file if LOCAL_TESTING is true
    let filesToProcess = files;
    if (process.env.LOCAL_TESTING === 'true') {
      filesToProcess = files.slice(0, 20);
      logInfo(`LOCAL_TESTING: Processing only ${filesToProcess.length} file(s) for testing`);
      // Update progress for testing
      if (progress) {
        progress.totalFiles = filesToProcess.length;
      }
    }

    // Filter out already processed files if resuming
    if (shouldResume && progress) {
      filesToProcess = filesToProcess.filter(file =>
        !progress!.processedFiles.includes(file.filename)
      );
      logInfo(`🔄 Resuming: ${filesToProcess.length} files remaining to process`);
    }

    // If no files left to process, return existing diff
    if (filesToProcess.length === 0) {
      logInfo("✅ All files already processed, loading existing diff");
      return progress ? reconstructDiffFromProgress(progress) : "";
    }

    // Combine individual file diffs
    let combinedDiff = (shouldResume && progress) ? reconstructDiffFromProgress(progress) : "";
    let processedFiles = 0;
    let skippedFiles = 0;
    let splitFiles = 0;

    // Process files in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < filesToProcess.length; i += batchSize) {
      const batch = filesToProcess.slice(i, i + batchSize);
      const batchNumber = (progress?.currentBatch || 0) + Math.floor(i/batchSize) + 1;
      logInfo(`Processing batch ${batchNumber} (${batch.length} files)`);

      // Process files in parallel within each batch
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          try {
            // For files that are too large, we'll focus on patches
            if (file.patch) {
              // Count the number of lines in the patch
              const patchLines = file.patch.split('\n').length;

              if (patchLines > 15000) {
                // If patch is too large, split it into smaller chunks
                logInfo(`File ${file.filename} has ${patchLines} lines, splitting into chunks`);
                splitFiles++;

                // Split the patch into manageable chunks
                const chunks = splitLargeFilePatch(file.filename, file.patch);

                // Track processed file
                if (progress) {
                  progress.processedFiles.push(file.filename);
                  saveProgress(progress);
                }

                return chunks.join('\n');
              } else {
                processedFiles++;

                // Track processed file
                if (progress) {
                  progress.processedFiles.push(file.filename);
                  saveProgress(progress);
                }

                return `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
              }
            }

            // For binary files or files without patches, create minimal diff info
            skippedFiles++;
            logInfo(`No patch data available for ${file.filename}, creating minimal diff info`);

            // Track processed file
            if (progress) {
              progress.processedFiles.push(file.filename);
              saveProgress(progress);
            }

            return `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ File change detected, but diff not available @@`;
          } catch (fileError) {
            skippedFiles++;
            logError(`Error processing ${file.filename}: ${fileError}`);

            // Track processed file even if it failed
            if (progress) {
              progress.processedFiles.push(file.filename);
              saveProgress(progress);
            }

            return `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ Error retrieving diff @@`;
          }
        })
      );

      combinedDiff += batchResults.join("\n");

      // Update progress
      if (progress) {
        progress.currentBatch = batchNumber;
        saveProgress(progress);
      }

      // Avoid rate limiting
      if (i + batchSize < filesToProcess.length) {
        const delay = 1000; // 1 second delay
        logInfo(`Waiting ${delay}ms before processing next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // Mark as completed if all files processed
    if (progress && progress.processedFiles.length >= progress.totalFiles) {
      progress.completed = true;
      progress.timestamp = new Date().toISOString();
      saveProgress(progress);
      logInfo("✅ All files processed - review session completed");
    }

    logInfo(`Successfully processed ${processedFiles} files. ${skippedFiles} files were processed with minimal diff info. ${splitFiles} large files were split into chunks.`);
    return combinedDiff || ""; // Ensure we never return null
  } catch (error) {
    logError(`Failed to fetch individual file diffs: ${error}`);
    // Save progress even on error
    if (progress) {
      saveProgress(progress);
    }
    // Return empty string as fallback so the process can continue
    return "";
  }
}

// Helper function to reconstruct diff from progress
function reconstructDiffFromProgress(progress: ReviewProgress): string {
  // This is a simplified reconstruction - in a real implementation,
  // you might want to store the actual diff content in progress
  return `# Previously processed ${progress.processedFiles.length} files\n# Files: ${progress.processedFiles.join(', ')}\n`;
}

/**
 * Splits a large file patch into smaller, more manageable chunks
 * @param filename The name of the file
 * @param patch The full patch content
 * @returns Array of diff chunks for the file
 */
function splitLargeFilePatch(filename: string, patch: string): string[] {
  // Split the patch by hunks (sections starting with @@ markers)
  const hunkRegex = /(@@ -\d+,\d+ \+\d+,\d+ @@.*)/g;
  const hunks = patch.split(hunkRegex).filter(Boolean);

  if (hunks.length <= 1) {
    // If we couldn't split by hunks, fall back to simple line splitting
    return splitByLines(filename, patch);
  }

  // Reconstruct hunks properly (the regex split removes the @@ markers)
  const properHunks: string[] = [];
  for (let i = 0; i < hunks.length; i += 2) {
    if (i + 1 < hunks.length) {
      properHunks.push(`${hunks[i]}${hunks[i+1]}`);
    } else {
      properHunks.push(hunks[i]);
    }
  }

  // Combine hunks into chunks of approximately 5000 lines each
  const chunks: string[] = [];
  let currentChunk = "";
  let currentChunkLines = 0;
  const maxLinesPerChunk = 5000;

  for (const hunk of properHunks) {
    const hunkLines = hunk.split('\n').length;

    if (currentChunkLines + hunkLines > maxLinesPerChunk && currentChunk !== "") {
      // This hunk would make the chunk too large, finish current chunk and start a new one
      chunks.push(`diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n${currentChunk}`);
      currentChunk = hunk;
      currentChunkLines = hunkLines;
    } else {
      // Add this hunk to the current chunk
      currentChunk += hunk;
      currentChunkLines += hunkLines;
    }
  }

  // Add the final chunk if there's anything left
  if (currentChunk !== "") {
    chunks.push(`diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n${currentChunk}`);
  }

  logInfo(`Split ${filename} into ${chunks.length} chunks`);
  return chunks;
}

/**
 * Simple fallback method to split a patch by lines when hunk splitting doesn't work
 */
function splitByLines(filename: string, patch: string): string[] {
  const lines = patch.split('\n');
  const chunks: string[] = [];
  const maxLinesPerChunk = 5000;

  for (let i = 0; i < lines.length; i += maxLinesPerChunk) {
    const chunkLines = lines.slice(i, i + maxLinesPerChunk);
    chunks.push(`diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n@@ Chunk ${Math.floor(i/maxLinesPerChunk) + 1}/${Math.ceil(lines.length/maxLinesPerChunk)} @@\n${chunkLines.join('\n')}`);
  }

  return chunks;
}

async function analyzeCode(
  parsedDiff: ParsedFile[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: ParsedFile, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ... { response_format: { type: "json_object" } }
        ,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    let res = response.choices[0].message?.content?.trim() || "{}";

    // Log the raw response for debugging
    // logInfo(`Raw response: ${res}`);

    // Clean markdown code blocks if present
    if (res.startsWith('```json')) {
      const lines = res.split('\n');
      // Remove first line (```json) and last line (```)
      lines.shift(); // Remove ```json
      if (lines[lines.length - 1].trim() === '```') {
        lines.pop(); // Remove closing ```
      }
      res = lines.join('\n').trim();
      // logInfo(`Cleaned markdown response: ${res}`);
    } else if (res.startsWith('```')) {
      // Handle generic code blocks
      const lines = res.split('\n');
      lines.shift(); // Remove opening ```
      if (lines[lines.length - 1].trim() === '```') {
        lines.pop(); // Remove closing ```
      }
      res = lines.join('\n').trim();
      // logInfo(`Cleaned generic markdown response: ${res}`);
    }

    // Additional cleanup for any remaining backticks
    res = res.replace(/^`+|`+$/g, '').trim();

    try {
      const parsed = JSON.parse(res);
      return parsed.reviews || parsed;
    } catch (parseError) {
      logError(`JSON Parse Error: ${parseError}. Cleaned response was: ${res}`);
      return null;
    }
  } catch (error) {
    logError(`Error: ${error}`);
    return null;
  }
}

function createComment(
  file: ParsedFile,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

// Function to validate if a comment line exists in the diff
function validateCommentLine(comments: ReviewComment[], parsedDiff: ParsedFile[]): ReviewComment[] {
  const validComments: ReviewComment[] = [];

  for (const comment of comments) {
    // Find the file in the parsed diff
    const fileInDiff = parsedDiff.find(file => file.to === comment.path || file.from === comment.path);

    if (!fileInDiff) {
      logWarning(`Skipping comment for ${comment.path} - file not found in diff`);
      continue;
    }

    // Check if the line exists in the diff chunks
    let lineExists = false;
    for (const chunk of fileInDiff.chunks || []) {
      for (const change of chunk.changes || []) {
        // Check different types of changes for line numbers
        if (change.type === 'add' && 'ln' in change && change.ln === comment.line) {
          lineExists = true;
          break;
        } else if (change.type === 'del' && 'ln' in change && change.ln === comment.line) {
          lineExists = true;
          break;
        } else if (change.type === 'normal' && 'ln1' in change && 'ln2' in change &&
                   (change.ln1 === comment.line || change.ln2 === comment.line)) {
          lineExists = true;
          break;
        }
      }
      if (lineExists) break;
    }

    if (lineExists) {
      validComments.push(comment);
    } else {
      logWarning(`Skipping comment for ${comment.path}:${comment.line} - line not found in diff`);
    }
  }

  logInfo(`Validated ${validComments.length}/${comments.length} comments`);
  return validComments;
}

// Function to post review comments for files
async function postReviewComments(
  owner: string,
  repo: string,
  pull_number: number,
  comments: ReviewComment[]
) {
  try {
    // Load progress and add comments to it
    let progress = loadProgress();
    if (progress) {
      progress.allComments = [...progress.allComments, ...comments];
      saveProgress(progress);
    }

    // Check if we're running in local testing mode
    if (process.env.LOCAL_TESTING === 'true') {
      logInfo(`LOCAL TEST MODE: Would post ${comments.length} review comments`);
      if (comments.length > 0) {
        logInfo(`Sample comment: ${JSON.stringify(comments[0])}`);
      }
      return true;
    }

    // Real GitHub API implementation for production use
    logInfo(`Submitting ${comments.length} review comments`);

    // Split comments into smaller batches to avoid GitHub API limitations
    const batchSize = 5; // Reduced from 10 to avoid rate limiting
    let successCount = 0;

    for (let i = 0; i < comments.length; i += batchSize) {
      const batchComments = comments.slice(i, i + batchSize);

      try {
        await octokit.pulls.createReview({
          owner,
          repo,
          pull_number,
          comments: batchComments,
          event: "COMMENT",
        });
        successCount += batchComments.length;

        // Add longer delay between batches to avoid rate limiting
        if (i + batchSize < comments.length) {
          const delay = 3000; // Increased from 1000ms to 3000ms
          logInfo(`Waiting ${delay}ms before processing next batch...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } catch (batchError: any) {
        logError(`Error posting batch of comments: ${batchError}`);

        // If we hit a rate limit, wait longer before continuing
        if (batchError.message?.includes('rate limit')) {
          logInfo('Rate limit detected, waiting 10 seconds...');
          await new Promise(resolve => setTimeout(resolve, 10000));
        }

        // Continue with next batch even if this one failed
      }
    }

    logInfo(`Successfully posted ${successCount}/${comments.length} review comments`);
    return true;
  } catch (error) {
    logError(`Error posting review comments: ${error}`);
    return false;
  }
}

// Add command line argument handling for progress management
function handleProgressCommands(): boolean {
  const args = process.argv.slice(2);

  if (args.includes('--clear-progress')) {
    clearProgress();
    console.log("✅ Progress file cleared");
    return true;
  }

  if (args.includes('--show-progress')) {
    const progress = loadProgress();
    if (progress) {
      console.log("📊 Current Progress:");
      console.log(`- PR: ${progress.repository}#${progress.prNumber}`);
      console.log(`- Files: ${progress.processedFiles.length}/${progress.totalFiles}`);
      console.log(`- Comments: ${progress.allComments.length}`);
      console.log(`- Last update: ${progress.timestamp}`);
      console.log(`- Completed: ${progress.completed}`);
      console.log(`- Processed files: ${progress.processedFiles.join(', ')}`);
    } else {
      console.log("📝 No progress file found");
    }
    return true;
  }

  if (args.includes('--export-comments')) {
    const progress = loadProgress();
    if (progress && progress.allComments.length > 0) {
      const exportFile = 'exported-comments.json';
      writeFileSync(exportFile, JSON.stringify(progress.allComments, null, 2));
      console.log(`📤 Exported ${progress.allComments.length} comments to ${exportFile}`);
    } else {
      console.log("📝 No comments to export");
    }
    return true;
  }

  return false;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>,
  parsedDiff: any[]
): Promise<void> {
  try {
    // Validate comments to ensure they reference existing lines in the diff
    const validComments = validateCommentLine(comments, parsedDiff);

    if (validComments.length === 0) {
      logWarning("No valid comments to post after validation");
      return;
    }

    // Use the improved postReviewComments function
    await postReviewComments(owner, repo, pull_number, validComments);
  } catch (error) {
    logError(`Error in createReviewComment: ${error}`);
  }
}

/**
 * Logs a message with GitHub Actions-specific formatting
 */
function logInfo(message: string): void {
  console.log(`::notice::${message}`);
}

/**
 * Logs a warning with GitHub Actions-specific formatting
 */
function logWarning(message: string): void {
  console.log(`::warning::${message}`);
}

/**
 * Logs an error with GitHub Actions-specific formatting
 */
function logError(message: string): void {
  console.log(`::error::${message}`);
}

/**
 * Logs a group start in GitHub Actions
 */
function logGroupStart(title: string): void {
  console.log(`::group::${title}`);
}

/**
 * Logs a group end in GitHub Actions
 */
function logGroupEnd(): void {
  console.log('::endgroup::');
}

/**
 * Logs a version banner with GitHub Actions-specific formatting
 */
function logVersionBanner(): void {
  logGroupStart("AI Code Reviewer v1.2.0");
  logInfo("Features enabled:");
  logInfo("✅ OpenRouter API support");
  logInfo("✅ File-by-file processing (avoids GitHub's 20,000 line limit)");
  logInfo("✅ Large file splitting for files over 15,000 lines");
  logGroupEnd();
}

/**
 * Main function that runs the AI Code Review process
 */
export async function main() {
  try {
    if (handleProgressCommands()) {
      return;
    }

    logVersionBanner();

    logInfo("Starting AI Code Reviewer");
    const prDetails = await getPRDetails();
    logInfo(`Processing PR #${prDetails.pull_number}: ${prDetails.title}`);

    let diff: string | null = null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );

    // Always use the file-by-file approach
    if (eventData.action === "opened") {
      logInfo("Processing newly opened PR using file-by-file approach");
      diff = await getIndividualFileDiffs(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      logInfo("Processing PR update (synchronize event)");
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;

      // For synchronize events, we still need to get file changes
      logInfo("Getting changed files between commits...");
      try {
        diff = await getIncrementalChanges(
          prDetails.owner,
          prDetails.repo,
          newBaseSha,
          newHeadSha
        );
      } catch (incrementalError) {
        logWarning(`Incremental changes failed: ${incrementalError}`);
        logInfo("Falling back to full PR analysis...");
        diff = await getIndividualFileDiffs(
          prDetails.owner,
          prDetails.repo,
          prDetails.pull_number
        );
      }
    } else {
      logWarning(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}, action: ${eventData.action}`);
      return;
    }

    if (!diff || diff.trim() === "") {
      logWarning("No diff found or empty diff returned");
      return;
    }

    const parsedDiff = parseDiff(diff);
    logInfo(`Parsed diff contains ${parsedDiff.length} files`);

    if (parsedDiff.length === 0) {
      logWarning("No changes to analyze after parsing diff");
      return;
    }

    const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());

    if (excludePatterns.length > 0 && excludePatterns[0] !== "") {
      logInfo(`Exclude patterns: ${excludePatterns.join(", ")}`);
    }

    const filteredDiff = parsedDiff.filter((file) => {
      return !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
      );
    });

    logInfo(`After filtering, ${filteredDiff.length} files will be analyzed`);

    if (filteredDiff.length === 0) {
      logWarning("All changed files were excluded by patterns");
      return;
    }

    logInfo("Starting code analysis...");
    const comments = await analyzeCode(filteredDiff, prDetails);

    if (comments.length > 0) {
      logInfo(`Submitting ${comments.length} review comments`);
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments,
        parsedDiff
      );
      logInfo("Review comments submitted successfully");
    } else {
      logInfo("No issues found, no comments to submit");
    }

    logInfo("AI Code Review completed successfully");
  } catch (error) {
    logError(`Error in main process: ${error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  logError(`Error: ${error}`);
  process.exit(1);
});

/**
 * Get only the new changes between two commits for synchronize events
 */
async function getIncrementalChanges(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string
): Promise<string> {
  logInfo(`Getting incremental changes between ${baseSha.substring(0, 7)} and ${headSha.substring(0, 7)}`);

  try {
    // Get the comparison between the two commits
    const { data: comparison } = await octokit.repos.compareCommits({
      owner,
      repo,
      base: baseSha,
      head: headSha,
    });

    logInfo(`Found ${comparison.files?.length || 0} files changed in the new commits`);

    if (!comparison.files || comparison.files.length === 0) {
      logInfo("No files changed in the new commits");
      return "";
    }

    // Build diff from the changed files
    let combinedDiff = "";
    let processedFiles = 0;
    let skippedFiles = 0;

    for (const file of comparison.files) {
      try {
        if (file.patch) {
          processedFiles++;
          combinedDiff += `diff --git a/${file.filename} b/${file.filename}\n${file.patch}\n`;
        } else {
          skippedFiles++;
          logInfo(`No patch data for ${file.filename} (likely binary or renamed)`);
          combinedDiff += `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ File change detected, but diff not available @@\n`;
        }
      } catch (fileError) {
        skippedFiles++;
        logError(`Error processing ${file.filename}: ${fileError}`);
      }
    }

    logInfo(`✅ Incremental changes processed:`);
    logInfo(`   📄 Processed: ${processedFiles} files`);
    logInfo(`   ⚠️  Skipped: ${skippedFiles} files`);

    return combinedDiff.trim();
  } catch (error) {
    logError(`Error getting incremental changes: ${error}`);
    throw error;
  }
}
