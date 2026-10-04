import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';

export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  version: string;
  status: GateStatus;
  /** 确认落账时的账本版本；列车或阻断一变即作废 */
  confirmedRevision: number | null;
  /** 确认已被作废、等待重新确认 */
  stale: boolean;
}

export interface Blocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
}

export interface GateSnapshot {
  gateId: string;
  repository: string;
  dependency: string;
  version: string;
}

export interface FreezeReceipt {
  reconciliationId: string;
  attempts: number;
  at: string;
  result: 'frozen' | 'failed' | 'superseded';
  reasons: string[];
  snapshot: GateSnapshot[] | null;
}

export interface PendingFreeze {
  reconciliationId: string;
  reasons: string[];
  gates: GateSnapshot[];
  attempts: number;
  updatedAt: string;
}

export interface FrozenSnapshot {
  at: string;
  reconciliationId: string;
  revision: number;
  gates: GateSnapshot[];
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  /** 一致账版本：列车或阻断任何变更都会递增 */
  ledgerRevision: number;
  gates: RepositoryGate[];
  blockers: Blocker[];
  /** 健康检查或门禁未过时被保留的待冻结清单 */
  pendingFreeze: PendingFreeze | null;
  /** 对账回执：按对账编号去重，同一编号只留一条 */
  receipts: FreezeReceipt[];
  /** 冻结时写入的版本快照，连同当时版本永久留账 */
  frozenSnapshot: FrozenSnapshot | null;
  audit: Array<{ id: string; at: string; text: string }>;
}

interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
}

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idSeq += 1)}`;
const now = () => new Date().toLocaleTimeString();
const newReconciliationId = (trainId: string) => `RC-${trainId.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${(idSeq += 1)}`;

const snapshotGates = (train: ReleaseTrain): GateSnapshot[] =>
  train.gates.map((gate) => ({ gateId: gate.id, repository: gate.repository, dependency: gate.dependency, version: gate.version }));

function log(train: ReleaseTrain, text: string) {
  train.audit.unshift({ id: nextId('a'), at: now(), text });
}

/**
 * 一致账核心：发布列车或阻断问题一变，账本版本递增，
 * 未冻结列车的全部门禁确认立即作废，等待重新确认；
 * 已冻结列车不作废，冻结快照连同当时版本留在审计里。
 */
function touchLedger(train: ReleaseTrain, reason: string) {
  train.ledgerRevision += 1;
  if (train.status === 'frozen') {
    log(train, reason);
    return;
  }
  const stale = train.gates.filter((gate) => gate.status === 'confirmed');
  for (const gate of stale) {
    gate.status = 'pending';
    gate.confirmedRevision = null;
    gate.stale = true;
  }
  log(train, stale.length ? `${reason}；${stale.length} 条确认作废，需重新确认` : reason);
}

/** 同一对账编号的回执只留一条，重复回执覆盖旧记录 */
function upsertReceipt(train: ReleaseTrain, receipt: FreezeReceipt) {
  const index = train.receipts.findIndex((item) => item.reconciliationId === receipt.reconciliationId);
  if (index >= 0) train.receipts[index] = receipt;
  else train.receipts.unshift(receipt);
}

const initial: TrainState = {
  activeId: 'train-101',
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    ledgerRevision: 0,
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0', confirmedRevision: 0, stale: false },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0', confirmedRevision: null, stale: false },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4', confirmedRevision: null, stale: false }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    pendingFreeze: null,
    receipts: [],
    frozenSnapshot: null,
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

const activeTrain = (state: TrainState) => state.trains.find((item) => item.id === state.activeId);

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = nextId('train');
      state.trains.push({
        id,
        ...action.payload,
        status: 'preparing',
        ledgerRevision: 0,
        gates: [],
        blockers: [],
        pendingFreeze: null,
        receipts: [],
        frozenSnapshot: null,
        audit: [{ id: nextId('a'), at: now(), text: '创建发布列车' }]
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    addGate(state, action: PayloadAction<{ repository: string; owner: string; dependency: string; version: string }>) {
      const train = activeTrain(state);
      if (!train || train.status === 'frozen') return;
      train.gates.push({ id: nextId('g'), ...action.payload, status: 'pending', confirmedRevision: null, stale: false });
      touchLedger(train, `接入仓库 ${action.payload.repository}`);
    },
    updateGate(state, action: PayloadAction<{ gateId: string; dependency: string; version: string }>) {
      const train = activeTrain(state);
      const gate = train?.gates.find((item) => item.id === action.payload.gateId);
      if (!train || !gate || train.status === 'frozen') return;
      gate.dependency = action.payload.dependency;
      gate.version = action.payload.version;
      touchLedger(train, `更新 ${gate.repository} 依赖为 ${gate.dependency}（${gate.version}）`);
    },
    confirmGate(state, action: PayloadAction<string>) {
      const train = activeTrain(state);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate || train.status === 'frozen') return;
      gate.status = 'confirmed';
      gate.confirmedRevision = train.ledgerRevision;
      gate.stale = false;
      log(train, `${gate.repository} 门禁按账本版本 #${train.ledgerRevision} 确认`);
    },
    addBlocker(state, action: PayloadAction<{ title: string; severity: Blocker['severity'] }>) {
      const train = activeTrain(state);
      if (!train || train.status === 'frozen') return;
      train.blockers.push({ id: nextId('b'), ...action.payload, resolved: false });
      touchLedger(train, `新增阻断：${action.payload.title}`);
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = activeTrain(state);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker || blocker.resolved) return;
      blocker.resolved = true;
      touchLedger(train, `关闭阻断：${blocker.title}`);
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = activeTrain(state);
      if (!train || train.status === 'frozen') return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      touchLedger(train, `调整 ${moved.repository} 的发布顺序`);
    },
    setStatus(state, action: PayloadAction<'preparing' | 'rolled-back'>) {
      const train = activeTrain(state);
      if (!train || train.status === action.payload) return;
      train.status = action.payload;
      train.pendingFreeze = null;
      const label = action.payload === 'rolled-back' ? '标记回滚' : '回到准备';
      touchLedger(train, `${label}${train.frozenSnapshot ? '（冻结快照保留于审计）' : ''}`);
    },
    discardPendingFreeze(state) {
      const train = activeTrain(state);
      if (!train || !train.pendingFreeze) return;
      log(train, `放弃待冻结对账 ${train.pendingFreeze.reconciliationId}`);
      train.pendingFreeze = null;
    },
    applyFreeze(state, action: PayloadAction<{ trainId: string; reconciliationId: string; baseRevision: number; healthOk: boolean; checkedAt: string }>) {
      const train = state.trains.find((item) => item.id === action.payload.trainId);
      if (!train) return;
      const { reconciliationId, baseRevision, healthOk, checkedAt } = action.payload;
      const prior = train.receipts.find((item) => item.reconciliationId === reconciliationId);
      const attempts = (prior?.attempts ?? 0) + 1;

      // 并发冻结：只认先写入的快照，后到者的提交作废并提示查看最新版本
      if (train.status === 'frozen' && train.frozenSnapshot) {
        upsertReceipt(train, {
          reconciliationId,
          attempts,
          at: now(),
          result: 'superseded',
          snapshot: null,
          reasons: [`对账 ${train.frozenSnapshot.reconciliationId} 已先写入冻结快照，本提交作废，请查看最新版本`]
        });
        log(train, `对账 ${reconciliationId} 晚于已落账的冻结快照，提交被拒`);
        return;
      }

      const reasons: string[] = [];
      if (train.ledgerRevision !== baseRevision) reasons.push(`提交基于账本版本 #${baseRevision}，当前已是 #${train.ledgerRevision}，请刷新后重新确认`);
      const openBlockers = train.blockers.filter((item) => !item.resolved);
      if (openBlockers.length) reasons.push(`阻断未关闭：${openBlockers.map((item) => item.title).join('、')}`);
      const unmet = train.gates.filter((item) => item.status !== 'confirmed' || item.confirmedRevision !== train.ledgerRevision);
      if (unmet.length) reasons.push(`依赖未满足：${unmet.map((item) => item.repository).join('、')} 门禁未确认或确认已作废`);
      if (!healthOk) reasons.push(`远端健康检查失败（${checkedAt}）`);

      if (reasons.length) {
        // 留住待冻结清单和原因，按同一对账编号等待重试
        const gates = snapshotGates(train);
        train.pendingFreeze = { reconciliationId, reasons, gates, attempts, updatedAt: now() };
        upsertReceipt(train, { reconciliationId, attempts, at: now(), result: 'failed', reasons, snapshot: gates });
        log(train, `冻结未达成（对账 ${reconciliationId}，第 ${attempts} 次）：${reasons.join('；')}。待冻结清单已保留，可按原对账编号重试`);
        return;
      }

      // 先写先得：落冻结快照，当时版本随快照永久留账
      const gates = snapshotGates(train);
      train.ledgerRevision += 1;
      train.status = 'frozen';
      train.frozenSnapshot = { at: now(), reconciliationId, revision: train.ledgerRevision, gates };
      train.pendingFreeze = null;
      upsertReceipt(train, { reconciliationId, attempts, at: now(), result: 'frozen', reasons: [], snapshot: gates });
      log(train, `列车冻结落账（对账 ${reconciliationId}），快照版本：${gates.map((item) => `${item.repository}@${item.version}`).join('、')}`);
    },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    }),
    checkFreezeHealth: builder.mutation<{ ready: boolean; checkedAt: string }, { trainId: string; simulateOutage: boolean }>({
      async queryFn({ trainId, simulateOutage }) {
        // 模拟远端健康检查的网络往返
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { data: { ready: !simulateOutage && trainId !== 'offline', checkedAt: new Date().toISOString() } };
      }
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;
export const {
  activateTrain,
  addBlocker,
  addGate,
  applyFreeze,
  confirmGate,
  createTrain,
  discardPendingFreeze,
  reorderGates,
  replaceState,
  resolveBlocker,
  setStatus,
  updateGate
} = trainSlice.actions;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware)
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/**
 * 提交冻结：先做远端健康检查，再把结果连同提交时的账本版本一起落账。
 * 重试时沿用待冻结清单上的对账编号，保证同一对账只留一条回执。
 */
export const submitFreeze = (input: { trainId: string; reconciliationId?: string; simulateOutage?: boolean }) =>
  async (dispatch: AppDispatch, getState: () => RootState) => {
    const train = getState().train.trains.find((item) => item.id === input.trainId);
    if (!train) return;
    const reconciliationId = input.reconciliationId ?? train.pendingFreeze?.reconciliationId ?? newReconciliationId(train.id);
    const baseRevision = train.ledgerRevision;
    const health = await dispatch(
      releaseApi.endpoints.checkFreezeHealth.initiate({ trainId: train.id, simulateOutage: !!input.simulateOutage })
    ).unwrap();
    dispatch(applyFreeze({ trainId: train.id, reconciliationId, baseRevision, healthOk: health.ready, checkedAt: health.checkedAt }));
  };

const STORAGE_KEY = 'yf53-release-ledger-v2';

if (typeof window !== 'undefined') {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) store.dispatch(replaceState(JSON.parse(saved) as TrainState));
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().train)));
}
