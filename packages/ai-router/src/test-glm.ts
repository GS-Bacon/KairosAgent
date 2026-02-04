/**
 * GLM統合テストスクリプト
 * 実行: npx tsx packages/ai-router/src/test-glm.ts
 */

import { getTaskRouter } from './task-router.js';
import { registerDefaultSkills } from './skills/index.js';

async function main() {
  console.log('=== GLM統合テスト開始 ===\n');

  // 環境変数チェック
  const apiKey = process.env.ZHIPU_API_KEY;
  console.log(`ZHIPU_API_KEY: ${apiKey ? '設定済み' : '❌ 未設定（OpenCodeの無料モデルを使用）'}`);


  // TaskRouter初期化
  const router = getTaskRouter();
  registerDefaultSkills(router);

  console.log('\n登録済みスキル:');
  const skills = router.getRegisteredSkills();
  skills.forEach((skillName: string) => {
    const def = router.getSkillDefinition(skillName);
    console.log(`  - ${skillName}: ${def?.description ?? 'N/A'}`);
  });

  // テスト実行
  console.log('\n--- keyword-research スキルテスト ---');
  try {
    const result = await router.executeSkill('keyword-research', {
      baseKeywords: ['副業'],
      productCategory: 'デジタル商品',
      language: '日本語',
      keywordCount: 3,
    });

    console.log('\n結果:');
    console.log(JSON.stringify(result, null, 2));

    // 統計確認
    const stats = router.getStats();
    console.log('\n統計:');
    console.log(JSON.stringify(stats, null, 2));

  } catch (error) {
    console.error('エラー:', error);
  }

  console.log('\n=== テスト完了 ===');
}

main().catch(console.error);
