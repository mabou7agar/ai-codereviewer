import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const API_KEY: string = core.getInput("OPENROUTER_API_KEY") || core.getInput("OPENAI_API_KEY");
const API_MODEL: string = core.getInput("OPENROUTER_API_MODEL") || core.getInput("OPENAI_API_MODEL");
const API_BASE_URL: string = core.getInput("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1";

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
      console.log("Diff too large (exceeds 20,000 lines). Fetching files individually...");
      return await getIndividualFileDiffs(owner, repo, pull_number);
    }
    
    // Re-throw any other errors
    console.error("Error fetching diff:", error);
    throw error;
  }
}

async function getIndividualFileDiffs(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string> {
  try {
    // Get list of files changed in the PR
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: 100, // Adjust as needed
    });

    console.log(`Found ${files.length} files to analyze individually`);
    
    if (files.length === 0) {
      console.warn("No files were found in the pull request.");
      return "";
    }
    
    // Combine individual file diffs
    let combinedDiff = "";
    let processedFiles = 0;
    let skippedFiles = 0;

    // Process files in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(files.length/batchSize)} (${batch.length} files)`);
      
      // Process files in parallel within each batch
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          try {
            // For files that are too large, we'll focus on patches
            if (file.patch) {
              processedFiles++;
              return `diff --git a/${file.filename} b/${file.filename}\n${file.patch}`;
            }
            
            // For binary files or files without patches, create minimal diff info
            skippedFiles++;
            console.log(`No patch data available for ${file.filename}, creating minimal diff info`);
            return `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ File change detected, but diff not available @@`;
          } catch (fileError) {
            skippedFiles++;
            console.error(`Error processing ${file.filename}:`, fileError);
            return `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n@@ Error retrieving diff @@`;
          }
        })
      );
      
      combinedDiff += batchResults.join("\n");
      
      // Avoid rate limiting
      if (i + batchSize < files.length) {
        const delay = 1000; // 1 second delay
        console.log(`Waiting ${delay}ms before processing next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.log(`Successfully processed ${processedFiles} files. ${skippedFiles} files were processed with minimal diff info.`);
    return combinedDiff || ""; // Ensure we never return null
  } catch (error) {
    console.error("Failed to fetch individual file diffs:", error);
    // Return empty string as fallback so the process can continue
    return "";
  }
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
    console.error("Error:", error);
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

async function main() {
  try {
    console.log("Starting AI Code Reviewer");
    const prDetails = await getPRDetails();
    console.log(`Processing PR #${prDetails.pull_number}: ${prDetails.title}`);

    let diff: string | null = null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );

    if (eventData.action === "opened") {
      console.log("Processing newly opened PR");
      diff = await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      console.log("Processing PR update (synchronize event)");
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;

      console.log(`Comparing commits: ${newBaseSha.slice(0, 7)}...${newHeadSha.slice(0, 7)}`);
      const response = await octokit.repos.compareCommits({
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
        owner: prDetails.owner,
        repo: prDetails.repo,
        base: newBaseSha,
        head: newHeadSha,
      });

      diff = String(response.data);
    } else {
      console.log(`Unsupported event: ${process.env.GITHUB_EVENT_NAME}, action: ${eventData.action}`);
      return;
    }

    if (!diff || diff.trim() === "") {
      console.log("No diff found or empty diff returned");
      return;
    }

    const parsedDiff = parseDiff(diff);
    console.log(`Parsed diff contains ${parsedDiff.length} files`);

    if (parsedDiff.length === 0) {
      console.log("No changes to analyze after parsing diff");
      return;
    }

    const excludePatterns = core
      .getInput("exclude")
      .split(",")
      .map((s) => s.trim());

    if (excludePatterns.length > 0 && excludePatterns[0] !== "") {
      console.log(`Exclude patterns: ${excludePatterns.join(", ")}`);
    }

    const filteredDiff = parsedDiff.filter((file) => {
      return !excludePatterns.some((pattern) =>
        minimatch(file.to ?? "", pattern)
      );
    });

    console.log(`After filtering, ${filteredDiff.length} files will be analyzed`);

    if (filteredDiff.length === 0) {
      console.log("All changed files were excluded by patterns");
      return;
    }

    console.log("Starting code analysis...");
    const comments = await analyzeCode(filteredDiff, prDetails);
    
    if (comments.length > 0) {
      console.log(`Submitting ${comments.length} review comments`);
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
      console.log("Review comments submitted successfully");
    } else {
      console.log("No issues found, no comments to submit");
    }

    console.log("AI Code Review completed successfully");
  } catch (error) {
    console.error("Error in main process:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
