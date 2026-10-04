import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
}
export interface Blocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
}
/** 冻结快照里留存的单个门禁：记录冻结当时的依赖与版本，不可变更。 */
export interface FreezeSnapshotGate {
  gateId: string;
  repository: string;
  dependency: string;
  version: string;
}
export interface FreezeSnapshotBlocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
}
/** 冻结回执：按对账编号归集，只保留先写入的那一份。 */
export interface FreezeReceipt {
  reconciliationId: string;
  at: string;
  trainVersion: number;
  gates: FreezeSnapshotGate[];
  blockers: FreezeSnapshotBlocker[];
}
/** 待冻结清单：健康检查失败或条件未满足时留住，按同一对账编号重试。 */
export interface PendingFreeze {
  reconciliationId: string;
  startedAt: string;
  attempts: number;
  awaitingHealth: boolean;
  reasons: string[];
  gates: FreezeSnapshotGate[];
  blockers: FreezeSnapshotBlocker[];
}
export interface AuditEntry {
  id: string;
  at: string;
  text: string;
}
export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  /** 乐观并发版本号：任何内容变更 +1，冻结提交时校验，先写入者生效。 */
  version: number;
  gates: RepositoryGate[];
  blockers: Blocker[];
  audit: AuditEntry[];
  /** 已冻结回执：冻结当时的版本快照，随审计留存。 */
  freezeReceipt?: FreezeReceipt;
  /** 待冻结清单：条件未满足或健康检查失败时留存，供重试。 */
  pendingFreeze?: PendingFreeze;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

const now = () => new Date().toLocaleTimeString();
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const newReconciliationId = () => `FRZ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function snapshotGates(gates: RepositoryGate[]): FreezeSnapshotGate[] {
  return gates.map((g) => ({ gateId: g.id, repository: g.repository, dependency: g.dependency, version: g.version }));
}
function snapshotBlockers(blockers: Blocker[]): FreezeSnapshotBlocker[] {
  return blockers.map((b) => ({ id: b.id, title: b.title, severity: b.severity }));
}

function pushAudit(train: ReleaseTrain, text: string) {
  train.audit.unshift({ id: nextId('a'), at: now(), text });
}

/** 冻结后任何内容变更一律拒绝，快照不可改写。 */
function frozenGuard(train: ReleaseTrain, action: string): boolean {
  if (train.status === 'frozen') {
    pushAudit(train, `已冻结，拒绝变更：${action}`);
    return true;
  }
  return false;
}

/**
 * 一致性作废：列车门禁（依赖/版本）或阻断问题一旦变更，
 * 未冻结列车上所有已确认门禁立即作废，需重新确认。
 */
function invalidateConfirmations(train: ReleaseTrain, reason: string) {
  let changed = false;
  for (const gate of train.gates) {
    if (gate.status === 'confirmed') {
      gate.status = 'pending';
      changed = true;
    }
  }
  if (changed) pushAudit(train, `列车台账变更，已确认门禁全部作废需重新确认：${reason}`);
}

/** 冻结前置条件：所有阻断关闭，且所有门禁确认（依赖满足）。 */
function freezePreconditions(train: ReleaseTrain): string[] {
  const reasons: string[] = [];
  if (train.status !== 'preparing') reasons.push(`列车状态为 ${train.status}，仅准备中可冻结`);
  for (const blocker of train.blockers) {
    if (!blocker.resolved) reasons.push(`阻断项未关闭：${blocker.title}`);
  }
  for (const gate of train.gates) {
    if (gate.status === 'blocked') reasons.push(`仓库 ${gate.repository} 门禁受阻：依赖 ${gate.dependency} 未满足`);
    else if (gate.status === 'pending') reasons.push(`仓库 ${gate.repository} 门禁未确认：依赖 ${gate.dependency}`);
  }
  return reasons;
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    version: 1,
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id, ...action.payload, status: 'preparing', version: 1,
        gates: [], blockers: [],
        audit: [{ id: nextId('a'), at: now(), text: '创建发布列车' }]
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },

    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      if (frozenGuard(train, `确认 ${gate.repository} 门禁`)) return;
      gate.status = 'confirmed';
      train.version += 1;
      pushAudit(train, `${gate.repository} 门禁由发布负责人确认（依赖 ${gate.dependency} / 版本 ${gate.version}）`);
    },

    /** 编辑门禁依赖/版本：依赖一改，旧确认立即作废。 */
    updateGate(state, action: PayloadAction<{ gateId: string; dependency: string; version: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate) return;
      if (frozenGuard(train, `修改 ${gate.repository} 依赖`)) return;
      const before = `${gate.dependency}@${gate.version}`;
      gate.dependency = action.payload.dependency.trim() || gate.dependency;
      gate.version = action.payload.version.trim() || gate.version;
      train.version += 1;
      invalidateConfirmations(train, `${gate.repository} 依赖由 ${before} 改为 ${gate.dependency}@${gate.version}`);
      train.pendingFreeze = undefined;
    },

    addGate(state, action: PayloadAction<{ repository: string; owner: string; dependency: string; version: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      if (frozenGuard(train, `新增仓库 ${action.payload.repository}`)) return;
      train.gates.push({ id: nextId('g'), status: 'pending', ...action.payload });
      train.version += 1;
      invalidateConfirmations(train, `新增仓库 ${action.payload.repository}（依赖 ${action.payload.dependency}）`);
      train.pendingFreeze = undefined;
    },

    removeGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate) return;
      if (frozenGuard(train, `移除仓库 ${gate.repository}`)) return;
      train.gates = train.gates.find((item) => item.id !== action.payload) ?? [];
      train.version += 1;
      invalidateConfirmations(train, `移除仓库 ${gate.repository}`);
      train.pendingFreeze = undefined;
    },

    addBlocker(state, action: PayloadAction<{ title: string; severity: 'warning' | 'critical' }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      if (frozenGuard(train, `新增阻断 ${action.payload.title}`)) return;
      train.blockers.push({ id: nextId('b'), resolved: false, ...action.payload });
      train.version += 1;
      invalidateConfirmations(train, `新增阻断：${action.payload.title}`);
      train.pendingFreeze = undefined;
    },

    updateBlocker(state, action: PayloadAction<{ blockerId: string; title: string; severity: 'warning' | 'critical' }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload.blockerId);
      if (!train || !blocker) return;
      if (frozenGuard(train, `修改阻断 ${blocker.title}`)) return;
      blocker.title = action.payload.title.trim() || blocker.title;
      blocker.severity = action.payload.severity;
      train.version += 1;
      invalidateConfirmations(train, `阻断变更：${blocker.title}`);
      train.pendingFreeze = undefined;
    },

    removeBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      if (frozenGuard(train, `移除阻断 ${blocker.title}`)) return;
      train.blockers = train.blockers.find((item) => item.id !== action.payload) ?? [];
      train.version += 1;
      invalidateConfirmations(train, `移除阻断：${blocker.title}`);
      train.pendingFreeze = undefined;
    },

    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker) return;
      if (frozenGuard(train, `关闭阻断 ${blocker.title}`)) return;
      blocker.resolved = true;
      train.version += 1;
      // 阻断集合变化，已确认门禁作废，需对照新台账重新确认。
      invalidateConfirmations(train, `阻断已关闭：${blocker.title}`);
      train.pendingFreeze = undefined;
    },

    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      if (frozenGuard(train, '调整发布顺序')) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      train.version += 1;
      pushAudit(train, `调整 ${moved.repository} 的发布顺序`);
    },

    /**
     * 发起冻结申请：生成待冻结清单并做前置校验。
     * 前置条件未满足时留住清单与原因；满足则置为等待远端健康检查。
     * 乐观并发：客户端版本与当前版本不一致，或已有申请在途时拒绝，先写入者生效。
     */
    requestFreeze(state, action: PayloadAction<{ reconciliationId: string; clientVersion: number }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const rid = action.payload.reconciliationId;
      if (train.status === 'frozen') {
        pushAudit(train, `冻结申请 ${rid} 拒绝：列车已冻结，快照不可重复写入`);
        return;
      }
      if (train.status !== 'preparing') {
        pushAudit(train, `冻结申请 ${rid} 拒绝：列车状态为 ${train.status}`);
        return;
      }
      if (action.payload.clientVersion !== train.version) {
        pushAudit(train, `冻结申请 ${rid} 拒绝：发布列车已被更新（本地 v${action.payload.clientVersion} / 最新 v${train.version}），请刷新后重新提交`);
        return;
      }
      if (train.pendingFreeze?.awaitingHealth) {
        pushAudit(train, `冻结申请 ${rid} 拒绝：对账编号 ${train.pendingFreeze.reconciliationId} 正在健康检查途中，先写入者生效`);
        return;
      }
      const reasons = freezePreconditions(train);
      const attempts = (train.pendingFreeze?.attempts ?? 0) + 1;
      train.pendingFreeze = {
        reconciliationId: rid,
        startedAt: now(),
        attempts,
        awaitingHealth: reasons.length === 0,
        reasons,
        gates: snapshotGates(train.gates),
        blockers: snapshotBlockers(train.blockers)
      };
      if (reasons.length) {
        pushAudit(train, `冻结申请 ${rid} 未满足前置条件，待冻结清单已留存（第 ${attempts} 次）：${reasons.join('；')}`);
      } else {
        pushAudit(train, `冻结申请 ${rid} 已留存待冻结清单（第 ${attempts} 次），等待远端健康检查`);
      }
    },

    /** 健康检查失败后，按同一对账编号重试，不清空已留存清单。 */
    retryFreeze(state, action: PayloadAction<{ clientVersion: number }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train || !train.pendingFreeze) return;
      if (train.status !== 'preparing') {
        pushAudit(train, `重试拒绝：列车状态为 ${train.status}`);
        return;
      }
      if (action.payload.clientVersion !== train.version) {
        pushAudit(train, `重试拒绝：发布列车已被更新（本地 v${action.payload.clientVersion} / 最新 v${train.version}），请重新发起冻结`);
        train.pendingFreeze = undefined;
        return;
      }
      train.pendingFreeze.awaitingHealth = true;
      train.pendingFreeze.attempts += 1;
      train.pendingFreeze.reasons = train.pendingFreeze.reasons.filter((r) => !r.startsWith('远端健康检查'));
      pushAudit(train, `按对账编号 ${train.pendingFreeze.reconciliationId} 重试冻结（第 ${train.pendingFreeze.attempts} 次）`);
    },

    /**
     * 冻结回执：健康检查完成后提交。
     * 幂等去重——同一对账编号只认一条回执，重复回执忽略；
     * 先写入者生效——仅 preparing 且版本一致时写入快照，后到者看到最新版本。
     */
    completeFreeze(state, action: PayloadAction<{ reconciliationId: string; healthy: boolean; reason?: string; clientVersion: number }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const rid = action.payload.reconciliationId;

      if (train.status === 'frozen') {
        pushAudit(train, `对账编号 ${rid} 回执忽略：列车已冻结（先写入快照已生效）`);
        return;
      }
      if (train.status !== 'preparing') {
        pushAudit(train, `对账编号 ${rid} 回执拒绝：列车状态为 ${train.status}`);
        return;
      }
      if (action.payload.clientVersion !== train.version) {
        pushAudit(train, `对账编号 ${rid} 回执拒绝：发布列车已被更新（本地 v${action.payload.clientVersion} / 最新 v${train.version}），请刷新后重试`);
        return;
      }
      if (!train.pendingFreeze) {
        pushAudit(train, `对账编号 ${rid} 回执拒绝：无待冻结清单`);
        return;
      }
      if (train.pendingFreeze.reconciliationId !== rid) {
        pushAudit(train, `对账编号 ${rid} 回执忽略：当前待冻结编号为 ${train.pendingFreeze.reconciliationId}，重复回执只留一条`);
        return;
      }

      // 提交前再校验一次前置条件，防止等待期间台账变化。
      const reasons = freezePreconditions(train);
      if (reasons.length) {
        train.pendingFreeze.reasons = reasons;
        train.pendingFreeze.awaitingHealth = false;
        pushAudit(train, `对账编号 ${rid} 冻结未满足前置条件，清单已留存：${reasons.join('；')}`);
        return;
      }

      if (!action.payload.healthy) {
        const reason = action.payload.reason ?? '远端健康检查未通过';
        if (!train.pendingFreeze.reasons.includes(reason)) train.pendingFreeze.reasons.push(reason);
        train.pendingFreeze.awaitingHealth = false;
        pushAudit(train, `对账编号 ${rid} 远端健康检查未通过，待冻结清单与原因已留存（第 ${train.pendingFreeze.attempts} 次），可按原编号重试`);
        return;
      }

      // 先写入者生效：写入冻结快照，版本号 +1，待冻结清单清空。
      train.version += 1;
      train.status = 'frozen';
      train.freezeReceipt = {
        reconciliationId: rid,
        at: now(),
        trainVersion: train.version,
        gates: snapshotGates(train.gates),
        blockers: snapshotBlockers(train.blockers)
      };
      train.pendingFreeze = undefined;
      const gateSummary = train.freezeReceipt.gates.map((g) => `${g.repository}(${g.dependency}@${g.version})`).join('、');
      pushAudit(train, `冻结生效（对账编号 ${rid} / 快照 v${train.freezeReceipt.trainVersion}），留存版本：${gateSummary}`);
    },

    /** 状态回退：回滚或回到准备；已冻结快照仍随审计保留。 */
    setFreeze(state, action: PayloadAction<'rolled-back' | 'preparing'>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.version += 1;
      train.pendingFreeze = undefined;
      pushAudit(train, `状态调整为 ${action.payload}，历史冻结快照仍留存审计`);
    },

    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export interface HealthQueryArgs {
  id: string;
  /** 演示用：置 true 模拟远端健康检查失败。 */
  fail?: boolean;
}
export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, HealthQueryArgs>({
      queryFn: ({ id, fail }) => ({ data: { ready: !fail && id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery, useLazyGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain, addBlocker, addGate, completeFreeze, confirmGate, createTrain,
  removeBlocker, removeGate, replaceState, requestFreeze, resolveBlocker,
  reorderGates, retryFreeze, setFreeze, updateBlocker, updateGate
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

/** 持久化迁移：补齐新增的版本号与冻结字段。 */
function normalizeTrain(raw: Partial<ReleaseTrain>): ReleaseTrain {
  return {
    id: raw.id ?? nextId('train'),
    name: raw.name ?? '未命名发布列车',
    freezeAt: raw.freezeAt ?? '',
    status: raw.status ?? 'preparing',
    version: typeof raw.version === 'number' ? raw.version : 1,
    gates: raw.gates ?? [],
    blockers: raw.blockers ?? [],
    audit: raw.audit ?? [],
    freezeReceipt: raw.freezeReceipt,
    pendingFreeze: raw.pendingFreeze
  };
}

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf53-release-state');
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as TrainState;
      const normalized: TrainState = {
        activeId: parsed.activeId,
        trains: (parsed.trains ?? []).map(normalizeTrain)
      };
      store.dispatch(replaceState(normalized));
    } catch {
      // 持久化数据损坏时忽略，使用初始状态。
    }
  }
  store.subscribe(() => localStorage.setItem('yf53-release-state', JSON.stringify(store.getState().train)));
}

export type RootState = ReturnType<typeof store.getState>;
export { newReconciliationId };
