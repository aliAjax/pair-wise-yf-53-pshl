import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, Modal, Progress, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  addBlocker,
  addGate,
  confirmGate,
  createTrain,
  discardPendingFreeze,
  reorderGates,
  resolveBlocker,
  setStatus,
  submitFreeze,
  updateGate,
  useGetTrainHealthQuery,
  type AppDispatch,
  type ReleaseTrain,
  type RepositoryGate,
  type RootState
} from '../store';

const trainSchema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const gateSchema = z.object({
  repository: z.string().min(2, '仓库名至少2个字符'),
  owner: z.string().min(1, '请填写负责人'),
  dependency: z.string().min(1, '请填写依赖'),
  version: z.string().min(1, '请填写版本')
});

const blockerSchema = z.object({
  title: z.string().min(3, '阻断标题至少3个字符'),
  severity: z.enum(['warning', 'critical'])
});

type GateModalState = { mode: 'create' } | { mode: 'edit'; gate: RepositoryGate } | null;

function SortableGate({ gate, frozen, onConfirm, onEdit }: { gate: RepositoryGate; frozen: boolean; onConfirm: () => void; onEdit: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id, disabled: frozen });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Text fw={700}>{gate.repository}</Text>
            {gate.stale && <Badge color="orange" variant="light">确认已作废</Badge>}
          </Group>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={frozen || gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" onClick={onEdit} disabled={frozen}>编辑依赖</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners} disabled={frozen}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

function GateModal({ modal, onClose }: { modal: GateModalState; onClose: () => void }) {
  const dispatch = useDispatch<AppDispatch>();
  const editing = modal?.mode === 'edit' ? modal.gate : null;
  const form = useForm<z.infer<typeof gateSchema>>({
    resolver: zodResolver(gateSchema),
    defaultValues: editing
      ? { repository: editing.repository, owner: editing.owner, dependency: editing.dependency, version: editing.version }
      : { repository: '', owner: '', dependency: '', version: '' }
  });
  return (
    <Modal opened={modal !== null} onClose={onClose} title={editing ? `编辑依赖 · ${editing.repository}` : '接入仓库'}>
      <form
        onSubmit={form.handleSubmit((values) => {
          if (editing) dispatch(updateGate({ gateId: editing.id, dependency: values.dependency, version: values.version }));
          else dispatch(addGate(values));
          onClose();
        })}
      >
        <Stack>
          <TextInput label="仓库" {...form.register('repository')} error={form.formState.errors.repository?.message} disabled={!!editing} />
          <TextInput label="负责人" {...form.register('owner')} error={form.formState.errors.owner?.message} disabled={!!editing} />
          <TextInput label="依赖" {...form.register('dependency')} error={form.formState.errors.dependency?.message} />
          <TextInput label="版本" {...form.register('version')} error={form.formState.errors.version?.message} />
          <Text size="xs" c="dimmed">保存后账本版本递增，未冻结列车的既有确认立即作废。</Text>
          <Button type="submit">{editing ? '保存并作废旧确认' : '接入仓库'}</Button>
        </Stack>
      </form>
    </Modal>
  );
}

function BlockerForm({ disabled }: { disabled: boolean }) {
  const dispatch = useDispatch<AppDispatch>();
  const form = useForm<z.infer<typeof blockerSchema>>({
    resolver: zodResolver(blockerSchema),
    defaultValues: { title: '', severity: 'critical' }
  });
  return (
    <form onSubmit={form.handleSubmit((values) => { dispatch(addBlocker(values)); form.reset(); })}>
      <Group align="flex-start" mt="md">
        <TextInput placeholder="登记新的阻断问题" style={{ flex: 1 }} {...form.register('title')} error={form.formState.errors.title?.message} disabled={disabled} />
        <Select
          w={130}
          data={[{ value: 'critical', label: 'critical' }, { value: 'warning', label: 'warning' }]}
          value={form.watch('severity')}
          onChange={(value) => form.setValue('severity', value === 'warning' ? 'warning' : 'critical')}
          disabled={disabled}
        />
        <Button type="submit" variant="light" disabled={disabled}>登记阻断</Button>
      </Group>
    </form>
  );
}

function FreezePanel({ train }: { train: ReleaseTrain }) {
  const dispatch = useDispatch<AppDispatch>();
  const [simulateOutage, setSimulateOutage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const frozen = train.status === 'frozen';
  const openBlockers = train.blockers.filter((item) => !item.resolved);
  const unmetGates = train.gates.filter((item) => item.status !== 'confirmed' || item.confirmedRevision !== train.ledgerRevision);

  async function submit() {
    setSubmitting(true);
    try {
      await dispatch(submitFreeze({ trainId: train.id, simulateOutage }));
    } finally {
      setSubmitting(false);
    }
  }

  function duel() {
    const tag = Date.now().toString(36).toUpperCase();
    dispatch(submitFreeze({ trainId: train.id, reconciliationId: `RC-DUEL-${tag}-A`, simulateOutage }));
    dispatch(submitFreeze({ trainId: train.id, reconciliationId: `RC-DUEL-${tag}-B`, simulateOutage }));
  }

  return (
    <Card withBorder>
      <Group justify="space-between">
        <Title order={3}>发布冻结</Title>
        <Text size="xs" c="dimmed">账本版本 #{train.ledgerRevision}</Text>
      </Group>
      <Stack gap={4} mt="md">
        <Text size="sm" c={openBlockers.length ? 'red' : 'green'}>{openBlockers.length ? '✗' : '✓'} 阻断全部关闭（剩余 {openBlockers.length}）</Text>
        <Text size="sm" c={unmetGates.length ? 'red' : 'green'}>{unmetGates.length ? '✗' : '✓'} 依赖门禁均按当前账本确认（未满足 {unmetGates.length}）</Text>
        <Text size="xs" c="dimmed">冻结落账后，快照连同当时版本永久留在审计。</Text>
      </Stack>
      <Switch mt="sm" label="模拟远端故障（健康检查失败）" checked={simulateOutage} onChange={(event) => setSimulateOutage(event.currentTarget.checked)} disabled={frozen} />

      {train.pendingFreeze && (
        <Alert color="red" mt="md" title={`待冻结清单保留中 · 对账编号 ${train.pendingFreeze.reconciliationId} · 第 ${train.pendingFreeze.attempts} 次尝试`}>
          <Stack gap="xs">
            {train.pendingFreeze.reasons.map((reason) => <Text key={reason} size="sm">· {reason}</Text>)}
            <Group gap="xs">{train.pendingFreeze.gates.map((gate) => <Badge key={gate.gateId} variant="light">{gate.repository}@{gate.version}</Badge>)}</Group>
            <div><Button size="xs" variant="subtle" color="red" onClick={() => dispatch(discardPendingFreeze())}>放弃本次对账</Button></div>
          </Stack>
        </Alert>
      )}

      {train.frozenSnapshot && (
        <Alert color="blue" mt="md" title={`已冻结快照 · 对账编号 ${train.frozenSnapshot.reconciliationId} · ${train.frozenSnapshot.at}`}>
          <Group gap="xs">{train.frozenSnapshot.gates.map((gate) => <Badge key={gate.gateId} color="blue" variant="light">{gate.repository}@{gate.version}</Badge>)}</Group>
        </Alert>
      )}

      <Group mt="md">
        <Button onClick={submit} disabled={frozen} loading={submitting}>
          {train.pendingFreeze ? '按原对账编号重试冻结' : '提交冻结'}
        </Button>
        <Button variant="light" onClick={duel} disabled={frozen}>并发冻结演练</Button>
        <Button color="red" variant="light" onClick={() => dispatch(setStatus('rolled-back'))} disabled={train.status === 'rolled-back'}>标记回滚</Button>
        <Button variant="default" onClick={() => dispatch(setStatus('preparing'))} disabled={train.status === 'preparing'}>回到准备</Button>
      </Group>
      <Text size="xs" c="dimmed" mt="sm">两人同时提交时只认先写入的快照，后到者收到作废回执并看到最新版本。</Text>
    </Card>
  );
}

function ReceiptsCard({ train }: { train: ReleaseTrain }) {
  return (
    <Card withBorder>
      <Title order={3} mb="xs">对账回执</Title>
      <Text size="xs" c="dimmed" mb="md">按对账编号去重，重复回执只留一条</Text>
      {train.receipts.length === 0 && <Text size="sm" c="dimmed">暂无回执</Text>}
      <Stack gap="xs">
        {train.receipts.map((receipt) => (
          <div key={receipt.reconciliationId} className="row">
            <Group justify="space-between">
              <Text size="sm" fw={600}>{receipt.reconciliationId}</Text>
              <Badge color={receipt.result === 'frozen' ? 'blue' : receipt.result === 'failed' ? 'red' : 'gray'}>
                {receipt.result === 'frozen' ? '已冻结' : receipt.result === 'failed' ? '未达成' : '已作废'}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">{receipt.at} · 第 {receipt.attempts} 次尝试</Text>
            {receipt.reasons.map((reason) => <Text key={reason} size="xs" c="red">· {reason}</Text>)}
            {receipt.snapshot && (
              <Group gap={4} mt={4}>{receipt.snapshot.map((gate) => <Badge key={gate.gateId} size="sm" variant="outline">{gate.repository}@{gate.version}</Badge>)}</Group>
            )}
          </div>
        ))}
      </Stack>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const [gateModal, setGateModal] = useState<GateModalState>(null);
  const form = useForm<z.infer<typeof trainSchema>>({ resolver: zodResolver(trainSchema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;
  const frozen = train?.status === 'frozen';

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>跨仓库版本、依赖、阻断项和门禁确认共用一本一致账：列车或阻断一变，既有确认立即作废；冻结只认先写入的快照。</Text>
        </div>
        <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder><Text size="xs">远端检查</Text><Title order={3}>{health?.ready ? '可达' : '等待'}</Title></Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>跨仓库依赖门禁</Title>
              <Group>
                <Text size="sm" c="dimmed">拖动调整分批发布顺序</Text>
                <Button size="xs" variant="light" onClick={() => setGateModal({ mode: 'create' })} disabled={frozen}>接入仓库</Button>
              </Group>
            </Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>
                  {train.gates.map((gate) => (
                    <SortableGate
                      key={gate.id}
                      gate={gate}
                      frozen={!!frozen}
                      onConfirm={() => dispatch(confirmGate(gate.id))}
                      onEdit={() => setGateModal({ mode: 'edit', gate })}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge>
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                </div>
                <Button variant="subtle" disabled={item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
            <BlockerForm disabled={!!frozen} />
            <Text size="xs" c="dimmed" mt="sm">登记或关闭阻断都会递增账本版本，未冻结列车的确认随之作废。</Text>
          </Card>
        </Stack>

        <Stack>
          <FreezePanel train={train} />
          <ReceiptsCard train={train} />

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit">创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 10).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name}</Button>)}
          </Card>
        </Stack>
      </div>

      <GateModal key={gateModal?.mode === 'edit' ? gateModal.gate.id : 'create'} modal={gateModal} onClose={() => setGateModal(null)} />
    </main>
  );
}
