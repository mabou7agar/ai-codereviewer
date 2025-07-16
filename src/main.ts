import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

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
  "openai/gpt-4";
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

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
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

    // Combine individual file diffs
    let combinedDiff = "";
    let processedFiles = 0;
    let skippedFiles = 0;
    let splitFiles = 0;

    // Process files in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      logInfo(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(files.length/batchSize)} (${batch.length} files)`);

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
                return chunks.join('\n');
              } else {
                processedFiles++;
                return `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
              }
            }

            // For binary files or files without patches, create minimal diff info
            skippedFiles++;
            logInfo(`No patch data available for ${file.filename}, creating minimal diff info`);
            return `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ File change detected, but diff not available @@`;
          } catch (fileError) {
            skippedFiles++;
            logError(`Error processing ${file.filename}: ${fileError}`);
            return `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ Error retrieving diff @@`;
          }
        })
      );

      combinedDiff += batchResults.join("\n");

      // Avoid rate limiting
      if (i + batchSize < files.length) {
        const delay = 1000; // 1 second delay
        logInfo(`Waiting ${delay}ms before processing next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logInfo(`Successfully processed ${processedFiles} files. ${skippedFiles} files were processed with minimal diff info. ${splitFiles} large files were split into chunks.`);
    return combinedDiff || ""; // Ensure we never return null
  } catch (error) {
    logError(`Failed to fetch individual file diffs: ${error}`);
    // Return empty string as fallback so the process can continue
    return "";
  }
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
  parsedDiff: File[],
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

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
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
      ...(API_MODEL === "gpt-4-1106-preview" || API_MODEL.includes("gpt-4") || API_MODEL.includes("claude")
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    logError(`Error: ${error}`);
    return null;
  }
}

function createComment(
  file: File,
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

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
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

async function main() {
  try {
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
      diff = await getIndividualFileDiffs(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
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
        comments
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
