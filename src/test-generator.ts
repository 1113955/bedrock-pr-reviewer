import * as fs from 'fs';
import * as path from 'path';
import { Bot } from './bot';
import { info } from '@actions/core';
import { TokenLimits } from './limits';
import { debug } from 'console';
import { octokit } from './octokit';
import { context as github_context } from '@actions/github';

export class TestGenerator {
  private bot: Bot;
  private tokenLimits: TokenLimits;

  constructor(bot: Bot, tokenLimits: TokenLimits) {
    this.bot = bot;
    this.tokenLimits = tokenLimits;
  }

  // Bloc 파일에 대한 테스트 생성
  async generateBlocTest(filePath: string, fileContent: string): Promise<string> {
    info(`Generating unit tests for Bloc file: ${filePath}`);

    const prompt = this.createBlocTestPrompt(filePath, fileContent);
    debug(`Prompt: ${prompt}`);

    try {
      const [response] = await this.bot.chat(prompt);
      debug(`Response: ${response}`);
      return this.parseTestCode(response);
    } catch (error) {
      info(`Error generating tests: ${error}`);
      return '';
    }
  }

  // 테스트 생성을 위한 프롬프트 작성
  private createBlocTestPrompt(filePath: string, fileContent: string): string {
    return `
IMPORTANT: Regardless of the language setting, you must provide the actual Dart code in English syntax.

You are an expert in Flutter development, specifically in implementing the Bloc pattern and writing comprehensive unit tests. Your task is to create a complete set of unit tests for a given Flutter Bloc file.

Here is the content of the Flutter Bloc file:
\`\`\`
${fileContent}
\`\`\`

And here is the path to the Flutter Bloc file:
File: ${filePath}

Before writing the tests, please analyze the Bloc file in detail. Conduct your analysis inside <bloc_analysis> tags, considering the following aspects:

1. List all events and states defined in the Bloc.
2. For each event, describe its main functionality and logic flow within the Bloc.
3. Identify any dependencies that need to be mocked for testing.
4. Outline potential success and error scenarios for each event.
5. Plan the structure of the test file, including necessary imports, test groups, and individual test cases.

After your analysis, generate comprehensive unit tests that meet the following criteria:
1. Test all events and states identified in your analysis.
2. Cover both success and error scenarios for each event.
3. Mock all necessary dependencies.
4. Utilize the bloc_test package for efficient Bloc testing.
5. Follow best practices for testing the Bloc pattern in Flutter.

Your output MUST be valid Dart code for a complete test file, without any additional explanations. Include necessary imports, test groups, and individual test cases. Ensure that your tests are thorough and would provide good coverage of the Bloc's functionality.

Here's an example of the structure your output should follow:

\`\`\`dart
import 'package:flutter_test/flutter_test.dart';
import 'package:bloc_test/bloc_test.dart';
// Other necessary imports

void main() {
  group('YourBlocName', () {
    // Setup and teardown

    blocTest<YourBlocName, YourBlocState>(
      'description of the test case',
      build: () => YourBlocName(),
      act: (bloc) => bloc.add(YourEvent()),
      expect: () => [
        // Expected states
      ],
    );

    // More test cases...
  });
}
\`\`\`

IMPORTANT: You must return ONLY the Dart code without any explanations or translations in other languages. Do NOT translate variable names or code syntax - keep all code as standard Dart.
`;
  }

  // 응답에서 테스트 코드만 추출
  private parseTestCode(response: string): string {
    const codeBlockRegex = /```(?:dart)?\n([\s\S]*?)```/;
    const match = response.match(codeBlockRegex);
    return match ? match[1].trim() : response.trim();
  }

  // 테스트 파일을 저장하고 PR에 코멘트와 함께 추가
  async saveTestFile(filePath: string, testCode: string): Promise<{ testFilePath: string, testCode: string }> {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath, path.extname(filePath));
    const testFilePath = path.join(dir, `${fileName}_test.dart`);
    
    try {
      // 로컬에 파일 저장 (선택 사항)
      await fs.promises.writeFile(testFilePath, testCode);
      info(`Test file saved locally: ${testFilePath}`);
      
      // PR에 파일 변경으로 추가
      try {
        const context = github_context;
        if (context.payload.pull_request) {
          const repo = context.repo;
          
          // 현재 브랜치의 최신 커밋 정보 가져오기
          const branchRef = `heads/${context.payload.pull_request.head.ref}`;
          const refData = await octokit.git.getRef({
            owner: repo.owner,
            repo: repo.repo,
            ref: branchRef.replace('refs/', '')
          });
          
          // 파일 내용을 base64로 인코딩하여 저장
          const fileContent = Buffer.from(testCode).toString('base64');
          
          // PR 브랜치에 파일 추가
          await octokit.repos.createOrUpdateFileContents({
            owner: repo.owner,
            repo: repo.repo,
            path: testFilePath,
            message: `자동 생성된 유닛 테스트: ${fileName}_test.dart`,
            content: fileContent,
            branch: context.payload.pull_request.head.ref,
            sha: refData.data.object.sha
          });
          
          info(`Test file added to PR: ${testFilePath}`);
        }
      } catch (prError) {
        info(`Note: Could not add test file to PR directly: ${prError}`);
        info('The test code will only be added as a comment.');
      }
      
      return { testFilePath, testCode };
    } catch (error) {
      info(`Error saving test file: ${error}`);
      return { testFilePath, testCode }; // 에러가 발생해도 코드는 반환
    }
  }
}
