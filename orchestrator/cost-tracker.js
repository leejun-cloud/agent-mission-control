/**
 * Cost Tracker
 * 세션별 API 호출 비용을 추적하고 예산 한도를 관리합니다.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');

class CostTracker {
  constructor(options = {}) {
    this.limitUSD = parseFloat(process.env.BUDGET_LIMIT_USD || '10');
    this.warningRatio = options.warningRatio || 0.8;  // 80%에서 경고
    this.totalUSD = 0;
    this.records = [];
    this.onWarning = options.onWarning || null;   // callback(message)
    this.onExceeded = options.onExceeded || null;  // callback(message)
  }

  /**
   * API 호출 비용을 기록합니다.
   * @param {Object} entry - { model, role, costUSD, tokens, sessionId }
   * @returns {boolean} false면 예산 초과로 중단 필요
   */
  record(entry) {
    this.totalUSD += entry.costUSD;
    this.records.push({
      ...entry,
      cumulativeUSD: this.totalUSD,
      timestamp: new Date().toISOString(),
    });

    // 경고선 확인
    if (this.totalUSD >= this.limitUSD * this.warningRatio && this.totalUSD < this.limitUSD) {
      const msg = `⚠️ 예산 경고: $${this.totalUSD.toFixed(2)} / $${this.limitUSD} (${Math.round(this.totalUSD / this.limitUSD * 100)}%)`;
      console.warn(msg);
      if (this.onWarning) this.onWarning(msg);
    }

    // 초과 확인
    if (this.totalUSD >= this.limitUSD) {
      const msg = `🛑 예산 한도 초과! $${this.totalUSD.toFixed(2)} / $${this.limitUSD} — 모든 작업을 중단합니다.`;
      console.error(msg);
      if (this.onExceeded) this.onExceeded(msg);
      return false;
    }

    return true;
  }

  /** 남은 예산 */
  remaining() {
    return Math.max(0, this.limitUSD - this.totalUSD);
  }

  /** 요약 리포트 */
  summary() {
    const byModel = {};
    for (const r of this.records) {
      if (!byModel[r.model]) byModel[r.model] = { count: 0, costUSD: 0, tokens: 0 };
      byModel[r.model].count++;
      byModel[r.model].costUSD += r.costUSD;
      byModel[r.model].tokens += r.tokens || 0;
    }
    return {
      totalUSD: Math.round(this.totalUSD * 10000) / 10000,
      limitUSD: this.limitUSD,
      remainingUSD: this.remaining(),
      calls: this.records.length,
      byModel,
    };
  }

  /** 세션 로그를 파일로 저장 */
  saveTo(filePath) {
    fs.writeFileSync(filePath, JSON.stringify(this.summary(), null, 2), 'utf8');
  }

  /** 예산 한도 재설정 */
  setLimit(newLimitUSD) {
    this.limitUSD = newLimitUSD;
  }

  /** 초기화 */
  reset() {
    this.totalUSD = 0;
    this.records = [];
  }
}

module.exports = CostTracker;
