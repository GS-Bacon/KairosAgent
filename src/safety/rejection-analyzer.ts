/**
 * 拒否理由の解析モジュール
 *
 * AIレビューの拒否理由テキストをパターンマッチで分類し、
 * 改善可能かどうかを判定する。
 */

import { RejectionAnalysis, RejectionCategory } from "./review-types.js";

interface CategoryPattern {
  category: RejectionCategory;
  patterns: RegExp[];
  isRemediable: boolean;
  requiredSupplements: string[];
}

const CATEGORY_PATTERNS: CategoryPattern[] = [
  {
    category: "missing-diff",
    patterns: [
      /diff|差分|変更内容|変更箇所|what.*chang/i,
      /no.*change.*provided|変更が.*提示.*ない/i,
      /cannot.*see.*modification|修正.*確認.*できない/i,
    ],
    isRemediable: true,
    requiredSupplements: ["diff"],
  },
  {
    category: "missing-context",
    patterns: [
      /context|コンテキスト|背景|理由|justification/i,
      /why.*change|なぜ.*変更/i,
      /insufficient.*information|情報.*不足/i,
      /more.*detail|詳細.*必要/i,
    ],
    isRemediable: true,
    requiredSupplements: ["context", "justification"],
  },
  {
    category: "security-concern",
    patterns: [
      /security|セキュリティ|脆弱性|vulnerab/i,
      /dangerous|危険|malicious|悪意/i,
      /injection|インジェクション|xss|csrf/i,
      /unsafe|安全でない/i,
    ],
    isRemediable: false,
    requiredSupplements: [],
  },
  {
    category: "quality-concern",
    patterns: [
      /quality|品質|不十分|inadequate/i,
      /poor.*code|コード.*品質/i,
      /bug|バグ|error.*prone|エラー/i,
      /regression|リグレッション/i,
    ],
    isRemediable: false,
    requiredSupplements: [],
  },
  {
    category: "scope-violation",
    patterns: [
      /scope|スコープ|範囲|outside.*boundary/i,
      /protected|保護|forbidden|禁止/i,
      /not.*allowed|許可.*ない/i,
      /beyond.*scope|範囲外/i,
    ],
    isRemediable: false,
    requiredSupplements: [],
  },
];

export class RejectionAnalyzer {
  /**
   * 拒否理由テキストを解析し、カテゴリと改善可能性を判定する
   */
  analyze(rejectionReason: string): RejectionAnalysis {
    for (const categoryPattern of CATEGORY_PATTERNS) {
      for (const pattern of categoryPattern.patterns) {
        if (pattern.test(rejectionReason)) {
          return {
            category: categoryPattern.category,
            isRemediable: categoryPattern.isRemediable,
            requiredSupplements: categoryPattern.requiredSupplements,
            originalReason: rejectionReason,
          };
        }
      }
    }

    // マッチしなかった場合はunknown（改善不可として扱う）
    return {
      category: "unknown",
      isRemediable: false,
      requiredSupplements: [],
      originalReason: rejectionReason,
    };
  }
}
