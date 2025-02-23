import {error, info, warning} from '@actions/core'
// eslint-disable-next-line camelcase
import {context as github_context} from '@actions/github'
import pLimit from 'p-limit'
import {type Bot} from './bot'
import {
  Commenter,
  COMMENT_REPLY_TAG,
  RAW_SUMMARY_END_TAG,
  RAW_SUMMARY_START_TAG,
  SHORT_SUMMARY_END_TAG,
  SHORT_SUMMARY_START_TAG,
  SUMMARIZE_TAG,
  COMMENT_TAG
} from './commenter'
import {Inputs} from './inputs'
import {octokit} from './octokit'
import {type Options} from './options'
import {type Prompts} from './prompts'
import {getTokenCount} from './tokenizer'

// eslint-disable-next-line camelcase
const context = github_context
const repo = context.repo

const ignoreKeyword = '/reviewbot: ignore'

export const codeReview = async (
  lightBot: Bot,
  heavyBot: Bot,
  options: Options,
  prompts: Prompts
): Promise<void> => {
  const commenter: Commenter = new Commenter()
  var existingReviewsContext = ""

    // Add this section after initial setup
  const pullNumber = context.payload.pull_request?.number
  if (!pullNumber) return

  info(`codeReview pullNumber ${pullNumber}`)
  try {
    // Get all review comments
    const comments = await octokit.pulls.listReviewComments({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullNumber
    })

    // 디버깅을 위한 상세 로깅 추가
    comments.data.forEach((comment, index) => {
      info(`Comment ${index + 1}:
        ID: ${comment.id}
        Body: ${comment.body}
        COMMENT_TAG value: ${COMMENT_TAG}
        Includes COMMENT_TAG (case sensitive): ${comment.body?.includes(COMMENT_TAG)}
        Includes COMMENT_TAG (case sensitive): ${comment.body?.includes(COMMENT_REPLY_TAG)}
        Includes COMMENT_TAG (case insensitive): ${comment.body?.toLowerCase().includes(COMMENT_TAG.toLowerCase())}
        Han ai generated comment: ${comment.body?.includes('This is an auto-generated reply by AI reviewer')} 
        Has HTML comment: ${comment.body?.includes('<!--')}
        Starts with [필수]: ${comment.body?.trimStart().startsWith('[필수]')}
        include with [필수]: ${comment.body?.includes('필수]')}
      `)
    });

    const aiComments = comments.data.filter(comment => comment.body?.includes(COMMENT_TAG))
    const aiReplyComments = comments.data.filter(comment => comment.body?.includes(COMMENT_REPLY_TAG))
    const requiredComments = comments.data.filter(comment => comment.body?.trimStart().startsWith('[필수]'))
    
    // Add handling for AI review comments with no replies
    const aiOnlyComments = comments.data.filter(comment => 
      comment.body?.includes(COMMENT_TAG) &&
      !comment.body?.includes(COMMENT_REPLY_TAG) && 
      !comment.body?.trimStart().startsWith('[필수]')
    );

    // Delete AI comments that have no replies
    const deletePromises = aiOnlyComments.map(async (comment) => {
      try {
        const replies = comments.data.filter(reply => 
          reply.in_reply_to_id === comment.id
        );

        if (replies.length === 0) {
          info(`Deleting unused AI comment ${comment.id}`);
          await octokit.pulls.deleteReviewComment({
            owner: repo.owner,
            repo: repo.repo,
            comment_id: comment.id
          });
        }
      } catch (e) {
        warning(`Failed to delete comment ${comment.id}: ${e}`);
      }
    });

    await Promise.all(deletePromises);
    info(`Processed ${aiOnlyComments.length} AI-only comments for cleanup`);

    // Continue with existing non-required comments handling...
    const nonRequiredComments = await Promise.all(comments.data
      .filter(comment => 
        (comment.body?.includes(COMMENT_TAG)
          || comment.body?.includes(COMMENT_REPLY_TAG))
        && !comment.body?.trimStart().startsWith('[필수]')
      )
      .map(async (comment) => {
        // Get entire comment chain for this comment
        const {chain} = await commenter.getCommentChain(pullNumber, comment);
        
        // Check if any comment in the chain includes the resolved message
        const isAlreadyResolved = chain.includes('✅ Automatically resolved as non-required comment.');
        
        return isAlreadyResolved ? null : comment;
      }))
      .then(results => results.filter((comment): comment is NonNullable<typeof comment> => comment !== null));

    info(`Comments breakdown:
      Total comments: ${comments.data.length}
      AI comments: ${aiComments.length}
      AI reply comments: ${aiReplyComments.length}
      Required comments: ${requiredComments.length}
      Non-required AI comments to resolve: ${nonRequiredComments.length}
    `)

    // Add existing reviews to system message
    existingReviewsContext = comments.data.length > 0 
      ? `\\n\\nPreviously reviewed comments:\\n${
          comments.data.map(comment => 
            `File: ${comment.path}\\nLines: ${comment.start_line || comment.line}\\nComment: ${
              comment.body?.replace(/\n/g, '\\n').replace(/\t/g, '\\t')
            }`
          ).join('\\n\\n')
        }\\n\\nPlease avoid making duplicate comments for the same issues that were already reviewed. Instead, focus on changed code only.`
      : '';

    info(`Existing reviews context (escaped): ${existingReviewsContext}`);

    // Resolve comments in parallel with rate limiting
    const resolvePromises = nonRequiredComments.map(async (comment: {id: number; body?: string}) => {
      try {
        info(`Resolving comment ${comment.id}, ${comment.body}`)
        await commenter.reviewCommentReply(
          pullNumber,
          comment,
          '✅ Automatically resolved as non-required comment.'
        )

        info(`Resolved comment ${comment.id}`)
      } catch (e) {
        warning(`Failed to resolve comment ${comment.id}: ${e}`)
      }
    })

    await Promise.all(resolvePromises)
    info(`Resolved ${nonRequiredComments.length} non-required comments`)
  } catch (e) {
    warning(`Error processing existing comments: ${e}`)
  }

  const bedrockConcurrencyLimit = pLimit(options.bedrockConcurrencyLimit)
  const githubConcurrencyLimit = pLimit(options.githubConcurrencyLimit)

  if (
    context.eventName !== 'pull_request' &&
    context.eventName !== 'pull_request_target'
  ) {
    warning(
      `Skipped: current event is ${context.eventName}, only support pull_request event`
    )
    return
  }
  if (context.payload.pull_request == null) {
    warning('Skipped: context.payload.pull_request is null')
    return
  }

  const inputs: Inputs = new Inputs()
  inputs.title = context.payload.pull_request.title
  if (context.payload.pull_request.body != null) {
    inputs.description = commenter.getDescription(
      context.payload.pull_request.body
    )
  }

  // if the description contains ignore_keyword, skip
  if (inputs.description.includes(ignoreKeyword)) {
    info('Skipped: description contains ignore_keyword')
    return
  }

  info(`Existing reviews context: ${existingReviewsContext}`);  // 로깅 추가
  inputs.systemMessage = options.systemMessage + existingReviewsContext;
  inputs.reviewFileDiff = options.reviewFileDiff

  // get SUMMARIZE_TAG message
  const existingSummarizeCmt = await commenter.findCommentWithTag(
    SUMMARIZE_TAG,
    context.payload.pull_request.number
  )
  let existingCommitIdsBlock = ''
  let existingSummarizeCmtBody = ''
  if (existingSummarizeCmt != null) {
    existingSummarizeCmtBody = existingSummarizeCmt.body
    inputs.rawSummary = commenter.getRawSummary(existingSummarizeCmtBody)
    inputs.shortSummary = commenter.getShortSummary(existingSummarizeCmtBody)
    existingCommitIdsBlock = commenter.getReviewedCommitIdsBlock(
      existingSummarizeCmtBody
    )
  }

  const allCommitIds = await commenter.getAllCommitIds()
  // find highest reviewed commit id
  let highestReviewedCommitId = ''
  if (existingCommitIdsBlock !== '') {
    highestReviewedCommitId = commenter.getHighestReviewedCommitId(
      allCommitIds,
      commenter.getReviewedCommitIds(existingCommitIdsBlock)
    )
  }

  if (
    highestReviewedCommitId === '' ||
    highestReviewedCommitId === context.payload.pull_request.head.sha
  ) {
    info(
      `Will review from the base commit: ${
        context.payload.pull_request.base.sha as string
      }`
    )
    highestReviewedCommitId = context.payload.pull_request.base.sha
  } else {
    info(`Will review from commit: ${highestReviewedCommitId}`)
  }

  // Fetch the diff between the highest reviewed commit and the latest commit of the PR branch
  const incrementalDiff = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: highestReviewedCommitId,
    head: context.payload.pull_request.head.sha
  })

  // Fetch the diff between the target branch's base commit and the latest commit of the PR branch
  const targetBranchDiff = await octokit.repos.compareCommits({
    owner: repo.owner,
    repo: repo.repo,
    base: context.payload.pull_request.base.sha,
    head: context.payload.pull_request.head.sha
  })

  const incrementalFiles = incrementalDiff.data.files
  const targetBranchFiles = targetBranchDiff.data.files

  if (incrementalFiles == null || targetBranchFiles == null) {
    warning('Skipped: files data is missing')
    return
  }

  // Filter out any file that is changed compared to the incremental changes
  const files = targetBranchFiles.filter(targetBranchFile =>
    incrementalFiles.some(
      incrementalFile => incrementalFile.filename === targetBranchFile.filename
    )
  )

  if (files.length === 0) {
    warning('Skipped: files is null')
    return
  }

  // skip files if they are filtered out
  const filterSelectedFiles = []
  const filterIgnoredFiles = []
  for (const file of files) {
    if (!options.checkPath(file.filename)) {
      info(`skip for excluded path: ${file.filename}`)
      filterIgnoredFiles.push(file)
    } else {
      filterSelectedFiles.push(file)
    }
  }

  if (filterSelectedFiles.length === 0) {
    warning('Skipped: filterSelectedFiles is null')
    return
  }

  const commits = incrementalDiff.data.commits

  if (commits.length === 0) {
    warning('Skipped: commits is null')
    return
  }

  // find hunks to review
  const filteredFiles: Array<
    [string, string, string, Array<[number, number, string]>] | null
  > = await Promise.all(
    filterSelectedFiles.map(file =>
      githubConcurrencyLimit(async () => {
        // retrieve file contents
        let fileContent = ''
        if (context.payload.pull_request == null) {
          warning('Skipped: context.payload.pull_request is null')
          return null
        }
        try {
          const contents = await octokit.repos.getContent({
            owner: repo.owner,
            repo: repo.repo,
            path: file.filename,
            ref: context.payload.pull_request.base.sha
          })
          if (contents.data != null) {
            if (!Array.isArray(contents.data)) {
              if (
                contents.data.type === 'file' &&
                contents.data.content != null
              ) {
                fileContent = Buffer.from(
                  contents.data.content,
                  'base64'
                ).toString()
              }
            }
          }
        } catch (e: any) {
          warning(
            `Failed to get file contents: ${
              e as string
            }. This is OK if it's a new file.`
          )
        }

        let fileDiff = ''
        if (file.patch != null) {
          fileDiff = file.patch
        }

        const patches: Array<[number, number, string]> = []
        for (const patch of splitPatch(file.patch)) {
          const patchLines = patchStartEndLine(patch)
          if (patchLines == null) {
            continue
          }
          const hunks = parsePatch(patch)
          if (hunks == null) {
            continue
          }
          const hunksStr = `
<new_hunk>
\`\`\`
${hunks.newHunk}
\`\`\`
</new_hunk>

<old_hunk>
\`\`\`
${hunks.oldHunk}
\`\`\`
</old_hunk>
`
          patches.push([
            patchLines.newHunk.startLine,
            patchLines.newHunk.endLine,
            hunksStr
          ])
        }
        if (patches.length > 0) {
          return [file.filename, fileContent, fileDiff, patches] as [
            string,
            string,
            string,
            Array<[number, number, string]>
          ]
        } else {
          return null
        }
      })
    )
  )

  // Filter out any null results
  const filesAndChanges = filteredFiles.filter(file => file !== null) as Array<
    [string, string, string, Array<[number, number, string]>]
  >

  if (filesAndChanges.length === 0) {
    error('Skipped: no files to review')
    return
  }

  let statusMsg = `<details>
<summary>Commits</summary>
Files that changed from the base of the PR and between ${highestReviewedCommitId} and ${
    context.payload.pull_request.head.sha
  } commits.
</details>
${
  filesAndChanges.length > 0
    ? `
<details>
<summary>Files selected (${filesAndChanges.length})</summary>

* ${filesAndChanges
        .map(([filename, , , patches]) => `${filename} (${patches.length})`)
        .join('\n* ')}
</details>
`
    : ''
}
${
  filterIgnoredFiles.length > 0
    ? `
<details>
<summary>Files ignored due to filter (${filterIgnoredFiles.length})</summary>

* ${filterIgnoredFiles.map(file => file.filename).join('\n* ')}

</details>
`
    : ''
}
`

  // update the existing comment with in progress status
  const inProgressSummarizeCmt = commenter.addInProgressStatus(
    existingSummarizeCmtBody,
    statusMsg
  )

  // add in progress status to the summarize comment
  await commenter.comment(`${inProgressSummarizeCmt}`, SUMMARIZE_TAG, 'replace')

  const summariesFailed: string[] = []

  const doSummary = async (
    filename: string,
    fileContent: string,
    fileDiff: string
  ): Promise<[string, string, boolean] | null> => {
    info(`summarize: ${filename}`)
    const ins = inputs.clone()
    if (fileDiff.length === 0) {
      warning(`summarize: file_diff is empty, skip ${filename}`)
      summariesFailed.push(`${filename} (empty diff)`)
      return null
    }

    ins.filename = filename
    ins.fileDiff = fileDiff

    // render prompt based on inputs so far
    const summarizePrompt = prompts.renderSummarizeFileDiff(
      ins,
      options.reviewSimpleChanges
    )
    const tokens = getTokenCount(summarizePrompt)

    if (tokens > options.lightTokenLimits.requestTokens) {
      info(`summarize: diff tokens exceeds limit, skip ${filename}`)
      summariesFailed.push(`${filename} (diff tokens exceeds limit)`)
      return null
    }

    // summarize content
    try {
      const [summarizeResp] = await lightBot.chat(summarizePrompt)

      if (summarizeResp === '') {
        info('summarize: nothing obtained from bedrock')
        summariesFailed.push(`${filename} (nothing obtained from bedrock)`)
        return null
      } else {
        if (options.reviewSimpleChanges === false) {
          // parse the comment to look for triage classification
          // Format is : [TRIAGE]: <NEEDS_REVIEW or APPROVED>
          // if the change needs review return true, else false
          const triageRegex = /\[TRIAGE\]:\s*(NEEDS_REVIEW|APPROVED)/
          const triageMatch = summarizeResp.match(triageRegex)

          if (triageMatch != null) {
            const triage = triageMatch[1]
            const needsReview = triage === 'NEEDS_REVIEW'

            // remove this line from the comment
            const summary = summarizeResp.replace(triageRegex, '').trim()
            info(`filename: ${filename}, triage: ${triage}`)
            return [filename, summary, needsReview]
          }
        }
        return [filename, summarizeResp, true]
      }
    } catch (e: any) {
      warning(`summarize: error from bedrock: ${e as string}`)
      summariesFailed.push(`${filename} (error from bedrock: ${e as string})})`)
      return null
    }
  }

  const summaryPromises = []
  const skippedFiles = []
  for (const [filename, fileContent, fileDiff] of filesAndChanges) {
    if (options.maxFiles <= 0 || summaryPromises.length < options.maxFiles) {
      summaryPromises.push(
        bedrockConcurrencyLimit(
          async () => await doSummary(filename, fileContent, fileDiff)
        )
      )
    } else {
      skippedFiles.push(filename)
    }
  }

  const summaries = (await Promise.all(summaryPromises)).filter(
    (summary: [string, string, boolean] | null) => summary !== null
  ) as Array<[string, string, boolean]>

  if (summaries.length > 0) {
    const batchSize = 10
    // join summaries into one in the batches of batchSize
    // and ask the bot to summarize the summaries
    for (let i = 0; i < summaries.length; i += batchSize) {
      const summariesBatch = summaries.slice(i, i + batchSize)
      for (const [filename, summary] of summariesBatch) {
        inputs.rawSummary += `---
${filename}: ${summary}
`
      }
      // ask Bedrock to summarize the summaries
      const [summarizeResp] = await heavyBot.chat(
        prompts.renderSummarizeChangesets(inputs)
      )
      if (summarizeResp === '') {
        warning('summarize: nothing obtained from bedrock')
      } else {
        inputs.rawSummary = summarizeResp
      }
    }
  }

  // final summary
  const [summarizeFinalResponse] = await heavyBot.chat(
    prompts.renderSummarize(inputs)
  )
  if (summarizeFinalResponse === '') {
    info('summarize: nothing obtained from bedrock')
  }

  if (options.disableReleaseNotes === false) {
    // final release notes
    const [releaseNotesResponse] = await heavyBot.chat(
      prompts.renderSummarizeReleaseNotes(inputs)
    )
    if (releaseNotesResponse === '') {
      info('release notes: nothing obtained from bedrock')
    } else {
      let message = '### Summary (generated)\n\n'
      message += releaseNotesResponse
      try {
        await commenter.updateDescription(
          context.payload.pull_request.number,
          message
        )
      } catch (e: any) {
        warning(`release notes: error from github: ${e.message as string}`)
      }
    }
  }

  // generate a short summary as well
  const [summarizeShortResponse] = await heavyBot.chat(
    prompts.renderSummarizeShort(inputs)
  )
  inputs.shortSummary = summarizeShortResponse

  let summarizeComment = `${summarizeFinalResponse}
${RAW_SUMMARY_START_TAG}
${inputs.rawSummary}
${RAW_SUMMARY_END_TAG}
${SHORT_SUMMARY_START_TAG}
${inputs.shortSummary}
${SHORT_SUMMARY_END_TAG}
`

  statusMsg += `
${
  skippedFiles.length > 0
    ? `
<details>
<summary>Files not processed due to max files limit (${
        skippedFiles.length
      })</summary>

* ${skippedFiles.join('\n* ')}

</details>
`
    : ''
}
${
  summariesFailed.length > 0
    ? `
<details>
<summary>Files not summarized due to errors (${
        summariesFailed.length
      })</summary>

* ${summariesFailed.join('\n* ')}

</details>
`
    : ''
}
`

  if (!options.disableReview) {
    const filesAndChangesReview = filesAndChanges.filter(([filename]) => {
      const needsReview =
        summaries.find(
          ([summaryFilename]) => summaryFilename === filename
        )?.[2] ?? true
      return needsReview
    })

    const reviewsSkipped = filesAndChanges
      .filter(
        ([filename]) =>
          !filesAndChangesReview.some(
            ([reviewFilename]) => reviewFilename === filename
          )
      )
      .map(([filename]) => filename)

    // failed reviews array
    const reviewsFailed: string[] = []
    let lgtmCount = 0
    let reviewCount = 0
    const doReview = async (
      filename: string,
      fileContent: string,
      patches: Array<[number, number, string]>
    ): Promise<void> => {
      info(`reviewing ${filename}`)
      // make a copy of inputs
      const ins: Inputs = inputs.clone()
      ins.filename = filename

      // calculate tokens based on inputs so far
      let tokens = getTokenCount(prompts.renderReviewFileDiff(ins))
      // loop to calculate total patch tokens
      let patchesToPack = 0
      for (const [, , patch] of patches) {
        const patchTokens = getTokenCount(patch)
        if (tokens + patchTokens > options.heavyTokenLimits.requestTokens) {
          info(
            `only packing ${patchesToPack} / ${patches.length} patches, tokens: ${tokens} / ${options.heavyTokenLimits.requestTokens}`
          )
          break
        }
        tokens += patchTokens
        patchesToPack += 1
      }

      let patchesPacked = 0
      for (const [startLine, endLine, patch] of patches) {
        if (context.payload.pull_request == null) {
          warning('No pull request found, skipping.')
          continue
        }
        // see if we can pack more patches into this request
        if (patchesPacked >= patchesToPack) {
          info(
            `unable to pack more patches into this request, packed: ${patchesPacked}, total patches: ${patches.length}, skipping.`
          )
          if (options.debug) {
            info(`prompt so far: ${prompts.renderReviewFileDiff(ins)}`)
          }
          break
        }
        patchesPacked += 1

        let commentChain = ''
        try {
          const allChains = await commenter.getCommentChainsWithinRange(
            context.payload.pull_request.number,
            filename,
            startLine,
            endLine,
            COMMENT_REPLY_TAG
          )

          // Check if previous comments should be resolved
          if (allChains.length > 0) {
            const shouldResolve = await commenter.shouldResolveComment(
              filename,
              startLine, 
              endLine,
              patch
            )
            
            if (shouldResolve) {
              // Get the comment IDs from the chains and resolve them
              const commentIds = extractCommentIds(allChains)
              for (const commentId of commentIds) {
                await commenter.resolveComment(commentId)
              }
            }
            
            if (commentChain !== '') {
              info(`Found comment chains: ${allChains} for ${filename}`)
              commentChain = allChains
            }
          }
        } catch (e: any) {
          warning(
            `Failed to get comments: ${e as string}, skipping. backtrace: ${
              e.stack as string
            }`
          )
        }
        // try packing comment_chain into this request
        const commentChainTokens = getTokenCount(commentChain)
        if (
          tokens + commentChainTokens >
          options.heavyTokenLimits.requestTokens
        ) {
          commentChain = ''
        } else {
          tokens += commentChainTokens
        }

        ins.patches += `
${patch}
`
        if (commentChain !== '') {
          ins.patches += `
<comment_chains>
\`\`\`
${commentChain}
\`\`\`
</comment_chains>
`
        }
      }

      if (patchesPacked > 0) {
        // perform review
        try {
          const [response] = await heavyBot.chat(
            prompts.renderReviewFileDiff(ins),
            '{'
          )
          if (response === '') {
            info('review: nothing obtained from bedrock')
            reviewsFailed.push(`${filename} (no response)`)
            return
          }
          // parse review
          const reviews = parseReview(response, patches)
          for (const review of reviews) {
            // check for LGTM
            if (
              !options.reviewCommentLGTM &&
              (review.comment.includes('LGTM') ||
                review.comment.includes('looks good to me'))
            ) {
              lgtmCount += 1
              continue
            }
            if (context.payload.pull_request == null) {
              warning('No pull request found, skipping.')
              continue
            }

            try {
              reviewCount += 1
              await commenter.bufferReviewComment(
                filename,
                review.startLine,
                review.endLine,
                `${review.comment}`
              )
            } catch (e: any) {
              reviewsFailed.push(`${filename} comment failed (${e as string})`)
            }
          }
        } catch (e: any) {
          warning(
            `Failed to review: ${e as string}, skipping. backtrace: ${
              e.stack as string
            }`
          )
          reviewsFailed.push(`${filename} (${e as string})`)
        }
      } else {
        reviewsSkipped.push(`${filename} (diff too large)`)
      }
    }

    const reviewPromises = []
    for (const [filename, fileContent, , patches] of filesAndChangesReview) {
      if (options.maxFiles <= 0 || reviewPromises.length < options.maxFiles) {
        reviewPromises.push(
          bedrockConcurrencyLimit(async () => {
            await doReview(filename, fileContent, patches)
          })
        )
      } else {
        skippedFiles.push(filename)
      }
    }

    await Promise.all(reviewPromises)

    statusMsg += `
${
  reviewsFailed.length > 0
    ? `<details>
<summary>Files not reviewed due to errors (${reviewsFailed.length})</summary>

* ${reviewsFailed.join('\n* ')}

</details>
`
    : ''
}
${
  reviewsSkipped.length > 0
    ? `<details>
<summary>Files skipped from review due to trivial changes (${
        reviewsSkipped.length
      })</summary>

* ${reviewsSkipped.join('\n* ')}

</details>
`
    : ''
}
<details>
<summary>Review comments generated (${reviewCount + lgtmCount})</summary>

* Review: ${reviewCount}
* LGTM: ${lgtmCount}

</details>

---

<details>
<summary>Tips</summary>

### Chat with AI reviewer (\`/reviewbot\`)
- Reply on review comments left by this bot to ask follow-up questions. A review comment is a comment on a diff or a file.
- Invite the bot into a review comment chain by tagging \`/reviewbot\` in a reply.

### Code suggestions
- The bot may make code suggestions, but please review them carefully before committing since the line number ranges may be misaligned. 
- You can edit the comment made by the bot and manually tweak the suggestion if it is slightly off.

### Pausing incremental reviews
- Add \`/reviewbot: ignore\` anywhere in the PR description to pause further reviews from the bot.

</details>
`
    // add existing_comment_ids_block with latest head sha
    summarizeComment += `\n${commenter.addReviewedCommitId(
      existingCommitIdsBlock,
      context.payload.pull_request.head.sha
    )}`

    // post the review
    await commenter.submitReview(
      context.payload.pull_request.number,
      commits[commits.length - 1].sha,
      statusMsg
    )
  }

  // post the final summary comment
  await commenter.comment(`${summarizeComment}`, SUMMARIZE_TAG, 'replace')
}

const splitPatch = (patch: string | null | undefined): string[] => {
  if (patch == null) {
    return []
  }

  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@).*$/gm

  const result: string[] = []
  let last = -1
  let match: RegExpExecArray | null
  while ((match = pattern.exec(patch)) !== null) {
    if (last === -1) {
      last = match.index
    } else {
      result.push(patch.substring(last, match.index))
      last = match.index
    }
  }
  if (last !== -1) {
    result.push(patch.substring(last))
  }
  return result
}

const patchStartEndLine = (
  patch: string
): {
  oldHunk: {startLine: number; endLine: number}
  newHunk: {startLine: number; endLine: number}
} | null => {
  const pattern = /(^@@ -(\d+),(\d+) \+(\d+),(\d+) @@)/gm
  const match = pattern.exec(patch)
  if (match != null) {
    const oldBegin = parseInt(match[2])
    const oldDiff = parseInt(match[3])
    const newBegin = parseInt(match[4])
    const newDiff = parseInt(match[5])
    return {
      oldHunk: {
        startLine: oldBegin,
        endLine: oldBegin + oldDiff - 1
      },
      newHunk: {
        startLine: newBegin,
        endLine: newBegin + newDiff - 1
      }
    }
  } else {
    return null
  }
}

const parsePatch = (
  patch: string
): {oldHunk: string; newHunk: string} | null => {
  const hunkInfo = patchStartEndLine(patch)
  if (hunkInfo == null) {
    return null
  }

  const oldHunkLines: string[] = []
  const newHunkLines: string[] = []

  let newLine = hunkInfo.newHunk.startLine

  const lines = patch.split('\n').slice(1) // Skip the @@ line

  // Remove the last line if it's empty
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  // Skip annotations for the first 3 and last 3 lines
  const skipStart = 3
  const skipEnd = 3

  let currentLine = 0

  const removalOnly = !lines.some(line => line.startsWith('+'))

  for (const line of lines) {
    currentLine++
    if (line.startsWith('-')) {
      oldHunkLines.push(`${line.substring(1)}`)
    } else if (line.startsWith('+')) {
      newHunkLines.push(`${newLine}: ${line.substring(1)}`)
      newLine++
    } else {
      // context line
      oldHunkLines.push(`${line}`)
      if (
        removalOnly ||
        (currentLine > skipStart && currentLine <= lines.length - skipEnd)
      ) {
        newHunkLines.push(`${newLine}: ${line}`)
      } else {
        newHunkLines.push(`${line}`)
      }
      newLine++
    }
  }

  return {
    oldHunk: oldHunkLines.join('\n'),
    newHunk: newHunkLines.join('\n')
  }
}

interface Review {
  startLine: number
  endLine: number
  comment: string
}

function parseReview(
  response: string,
  // eslint-disable-next-line no-unused-vars
  patches: Array<[number, number, string]>
): Review[] {
  const reviews: Review[] = []

  try {
    const rawReviews = JSON.parse(response).reviews
    for (const r of rawReviews) {
      if (r.comment) {
        reviews.push({
          startLine: r.line_start ?? 0,
          endLine: r.line_end ?? 0,
          comment: r.comment
        })
      }
    }
  } catch (e: any) {
    error(e.message)
    return []
  }

  return reviews
}

function extractCommentIds(commentChains: string): number[] {
  // Extract comment IDs from the comment chains text
  const idPattern = /Comment ID: (\d+)/g
  const matches = [...commentChains.matchAll(idPattern)]
  return matches.map(match => parseInt(match[1]))
}
