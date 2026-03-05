/**
 * Slack Notifier
 * 작업 완료/실패/경고를 Slack Webhook으로 알립니다.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

/**
 * Slack 메시지를 전송합니다.
 * @param {string} text - 메시지 본문
 * @param {Object} options - { blocks, color }
 */
async function send(text, options = {}) {
  if (!SLACK_WEBHOOK_URL) {
    console.log(`[Slack 미설정] ${text}`);
    return { ok: false, reason: 'SLACK_WEBHOOK_URL not configured' };
  }

  const payload = { text };

  // 리치 포맷 (선택)
  if (options.blocks) {
    payload.blocks = options.blocks;
  }

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`Slack 전송 실패: ${res.status}`);
      return { ok: false, status: res.status };
    }

    return { ok: true };
  } catch (err) {
    console.error(`Slack 전송 오류: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * 세션 완료 알림을 전송합니다.
 */
async function notifySessionComplete({ projectName, sessionName, duration, costUSD, filesChanged, deployURL, summary }) {
  const text = [
    `✅ *${sessionName}* 완료`,
    ``,
    `📁 프로젝트: ${projectName}`,
    `🕐 소요 시간: ${duration}`,
    `💰 사용 비용: $${costUSD.toFixed(2)}`,
    `📦 변경 파일: ${filesChanged}개`,
    deployURL ? `🌐 배포 URL: ${deployURL}` : '',
    ``,
    `*변경 요약:*`,
    summary || '(요약 없음)',
  ].filter(Boolean).join('\n');

  return send(text);
}

/**
 * 긴급 알림을 전송합니다.
 */
async function notifyEmergency(message) {
  return send(`🚨 *긴급 알림*\n${message}`);
}

/**
 * 예산 경고를 전송합니다.
 */
async function notifyBudgetWarning(currentUSD, limitUSD) {
  return send(`⚠️ *예산 경고*: $${currentUSD.toFixed(2)} / $${limitUSD} (${Math.round(currentUSD / limitUSD * 100)}%)`);
}

module.exports = { send, notifySessionComplete, notifyEmergency, notifyBudgetWarning };
