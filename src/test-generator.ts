import * as fs from 'fs';
import * as path from 'path';
import { Bot } from './bot';
import { info } from '@actions/core';
import { TokenLimits } from './limits';
import { debug } from 'console';

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

  // 테스트 파일 저장
  async saveTestFile(filePath: string, testCode: string): Promise<string> {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath, path.extname(filePath));
    const testFilePath = path.join(dir, `${fileName}_test.dart`);
    
    try {
      await fs.promises.writeFile(testFilePath, testCode);
      info(`Test file saved: ${testFilePath}`);
      return testFilePath;
    } catch (error) {
      info(`Error saving test file: ${error}`);
      throw error;
    }
  }
}
