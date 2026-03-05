/**
 * Worker Pool
 * 여러 AI 워커를 병렬로 실행하고 결과를 취합합니다.
 *
 * 사용법:
 *   const pool = new WorkerPool({ maxConcurrency: 3 });
 *   const results = await pool.run(taskGroups, async (tasks, workerId) => { ... });
 */

class WorkerPool {
  /**
   * @param {Object} opts
   * @param {number} opts.maxConcurrency - 동시 실행할 최대 워커 수 (기본: 3)
   * @param {Function} opts.onWorkerStart - (workerId, tasks) => void
   * @param {Function} opts.onWorkerDone  - (workerId, result) => void
   * @param {Function} opts.onWorkerError - (workerId, error) => void
   */
  constructor(opts = {}) {
    this.maxConcurrency = opts.maxConcurrency || 3;
    this.onWorkerStart  = opts.onWorkerStart || null;
    this.onWorkerDone   = opts.onWorkerDone  || null;
    this.onWorkerError  = opts.onWorkerError || null;
    this.results        = [];
    this.errors         = [];
    this.workerStates   = {}; // { workerId: 'idle'|'running'|'done'|'error' }
  }

  /**
   * 태스크 그룹들을 병렬로 실행합니다.
   * @param {Array} taskGroups - 태스크 그룹 배열 (각 그룹은 한 워커에게 할당)
   * @param {Function} workerFn - async (tasks, workerId) => result
   * @returns {Array} 각 워커의 결과 배열
   */
  async run(taskGroups, workerFn) {
    this.results = [];
    this.errors  = [];

    // 큐를 청크로 나눠 maxConcurrency 씩 병렬 실행
    for (let i = 0; i < taskGroups.length; i += this.maxConcurrency) {
      const chunk = taskGroups.slice(i, i + this.maxConcurrency);

      const promises = chunk.map(async (tasks, idx) => {
        const workerId = i + idx + 1;
        this.workerStates[workerId] = 'running';

        if (this.onWorkerStart) this.onWorkerStart(workerId, tasks);

        try {
          const result = await workerFn(tasks, workerId);
          this.workerStates[workerId] = 'done';
          this.results.push({ workerId, tasks, result, ok: true });
          if (this.onWorkerDone) this.onWorkerDone(workerId, result);
          return result;
        } catch (err) {
          this.workerStates[workerId] = 'error';
          this.errors.push({ workerId, tasks, error: err.message });
          if (this.onWorkerError) this.onWorkerError(workerId, err);
          return null;
        }
      });

      await Promise.all(promises);
    }

    return {
      results: this.results,
      errors:  this.errors,
      states:  this.workerStates,
      success: this.errors.length === 0,
    };
  }

  /**
   * 모든 워커의 현재 상태를 반환합니다.
   */
  getStates() {
    return { ...this.workerStates };
  }
}

module.exports = WorkerPool;
