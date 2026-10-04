import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Switch, Text, TextInput, Title
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain, addBlocker, addGate, completeFreeze, confirmGate, createTrain,
  newReconciliationId, removeBlocker, removeGate, requestFreeze, resolveBlocker,
  reorderGates, retryFreeze, setFreeze, updateBlocker, updateGate,
  useLazyGetTrainHealthQuery, type Blocker, type RepositoryGate, type RootState
} from '../store';

const trainSchema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});
const gateSchema = z.object({
  repository: z.string().min(2, '仓库名至少2个字符'),
  owner: z.string().min(1, '请填写负责人'),
  dependency: z.string().min(2, '请填写依赖，如 shared-ui@4.2'),
  version: z.string().min(1, '请填写版本')
});
const blockerSchema = z.object({ title: z.string().min(3, '阻断标题至少3个字符'), severity: z.enum(['warning', 'critical']) });

function statusColor(status: RepositoryGate['status']) {
  return status === 'confirmed' ? 'green' : status === 'blocked' ? 'red' : 'yellow';
}

function SortableGate({ gate, frozen, onConfirm, onUpdate, onRemove }: {
  gate: RepositoryGate;
  frozen: boolean;
  onConfirm: () => void;
  onUpdate: (dependency: string, version: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  const [editing, setEditing] = useState(false);
  const [dep, setDep] = useState(gate.dependency);
  const [ver, setVer] = useState(gate.version);
  useEffect(() => { setDep(gate.dependency); setVer(gate.version); }, [gate.dependency, gate.version]);

  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group>
          <Badge color={statusColor(gate.status)}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={frozen || gate.status === 'confirmed'}>
            {gate.status === 'confirmed' ? '已确认' : '确认门禁'}
          </Button>
          <Button size="xs" variant="subtle" onClick={() => setEditing((v) => !v)} disabled={frozen}>编辑依赖</Button>
          <Button size="xs" variant="subtle" color="red" onClick={onRemove} disabled={frozen}>移除</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners} disabled={frozen}>拖拽排序</Button>
        </Group>
      </Group>
      {editing && (
        <Group mt="md" align="flex-end">
          <TextInput label="依赖" value={dep} onChange={(e) => setDep(e.currentTarget.value)} size="xs" />
          <TextInput label="版本" value={ver} onChange={(e) => setVer(e.currentTarget.value)} size="xs" />
          <Button size="xs" onClick={() => { onUpdate(dep, ver); setEditing(false); }}>保存并作废旧确认</Button>
          <Button size="xs" variant="default" onClick={() => { setDep(gate.dependency); setVer(gate.version); setEditing(false); }}>取消</Button>
        </Group>
      )}
    </Card>
  );
}

function BlockerRow({ blocker, frozen, onResolve, onUpdate, onRemove }: {
  blocker: Blocker;
  frozen: boolean;
  onResolve: () => void;
  onUpdate: (title: string, severity: Blocker['severity']) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(blocker.title);
  const [severity, setSeverity] = useState<Blocker['severity']>(blocker.severity);
  useEffect(() => { setTitle(blocker.title); setSeverity(blocker.severity); }, [blocker.title, blocker.severity]);

  return (
    <div className="row">
      <Group justify="space-between" align="center">
        <div>
          <Badge color={blocker.severity === 'critical' ? 'red' : 'yellow'}>{blocker.severity}</Badge>
          <Text component="span" ml="sm" td={blocker.resolved ? 'line-through' : undefined}>{blocker.title}</Text>
        </div>
        <Group>
          <Button size="xs" variant="subtle" onClick={() => setEditing((v) => !v)} disabled={frozen}>编辑</Button>
          <Button size="xs" variant="subtle" color="red" onClick={onRemove} disabled={frozen}>移除</Button>
          <Button size="xs" variant="subtle" disabled={frozen || blocker.resolved} onClick={onResolve}>关闭</Button>
        </Group>
      </Group>
      {editing && (
        <Group mt="sm" align="flex-end">
          <TextInput label="阻断标题" value={title} onChange={(e) => setTitle(e.currentTarget.value)} size="xs" style={{ flex: 1 }} />
          <Button size="xs" variant={severity === 'critical' ? 'filled' : 'default'} color="red" onClick={() => setSeverity('critical')}>critical</Button>
          <Button size="xs" variant={severity === 'warning' ? 'filled' : 'default'} color="yellow" onClick={() => setSeverity('warning')}>warning</Button>
          <Button size="xs" onClick={() => { onUpdate(title, severity); setEditing(false); }}>保存并作废旧确认</Button>
          <Button size="xs" variant="default" onClick={() => { setTitle(blocker.title); setSeverity(blocker.severity); setEditing(false); }}>取消</Button>
        </Group>
      )}
    </div>
  );
}

export default function Home() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];

  const [healthFail, setHealthFail] = useState(false);
  const healthFailRef = useRef(healthFail);
  healthFailRef.current = healthFail;
  const [triggerHealth, { isFetching: checking }] = useLazyGetTrainHealthQuery();

  const sensors = useSensors(useSensor(PointerSensor));
  const trainForm = useForm<z.infer<typeof trainSchema>>({ resolver: zodResolver(trainSchema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });
  const gateForm = useForm<z.infer<typeof gateSchema>>({ resolver: zodResolver(gateSchema), defaultValues: { repository: '', owner: '', dependency: '', version: '' } });
  const blockerForm = useForm<z.infer<typeof blockerSchema>>({ resolver: zodResolver(blockerSchema), defaultValues: { title: '', severity: 'critical' } });

  const pending = train?.pendingFreeze;
  const receipt = train?.freezeReceipt;
  const frozen = train?.status === 'frozen';
  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;

  // 待冻结清单置为等待健康检查时，自动发起远端检查并按同一对账编号提交回执。
  useEffect(() => {
    if (!pending?.awaitingHealth || !train) return;
    let cancelled = false;
    const clientVersion = train.version;
    (async () => {
      const res = await triggerHealth({ id: train.id, fail: healthFailRef.current });
      if (cancelled) return;
      const ready = res.data?.ready ?? false;
      dispatch(completeFreeze({
        reconciliationId: pending.reconciliationId,
        healthy: ready,
        reason: ready ? undefined : '远端健康检查未通过：依赖或门禁状态与远端台账不一致',
        clientVersion
      }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.awaitingHealth, pending?.reconciliationId, train?.id]);

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  function startFreeze() {
    if (!train) return;
    dispatch(requestFreeze({ reconciliationId: newReconciliationId(), clientVersion: train.version }));
  }

  function retryFreezeFlow() {
    if (!train) return;
    dispatch(retryFreeze({ clientVersion: train.version }));
  }

  function simulateConcurrentFreeze() {
    if (!train) return;
    dispatch(requestFreeze({ reconciliationId: `${newReconciliationId()}-B`, clientVersion: train.version }));
  }

  if (!train) return null;
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>跨仓库版本、依赖、阻断项和门禁确认记成一本一致账：台账一变，旧确认立即作废；冻结快照连同版本留存审计。</Text>
        </div>
        <Group>
          <Badge size="xl" color={frozen ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
          <Badge size="xl" variant="outline">v{train.version}</Badge>
        </Group>
      </header>

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder>
          <Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title>
          <Progress mt="sm" value={(confirmed / Math.max(train.gates.length, 1)) * 100} />
        </Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder>
          <Text size="xs">远端检查</Text>
          <Title order={3} c={checking ? 'yellow' : healthFail ? 'red' : 'green'}>
            {checking ? '检查中' : healthFail ? '失败' : '可达'}
          </Title>
        </Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md">
              <Title order={3}>跨仓库依赖门禁</Title>
              <Text size="sm" c="dimmed">依赖或版本一改，已确认门禁立即作废</Text>
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
                      onUpdate={(dependency, version) => dispatch(updateGate({ gateId: gate.id, dependency, version }))}
                      onRemove={() => dispatch(removeGate(gate.id))}
                    />
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
            <form onSubmit={gateForm.handleSubmit((values) => { dispatch(addGate(values)); gateForm.reset(); })}>
              <Group mt="md" align="flex-end">
                <TextInput label="仓库" {...gateForm.register('repository')} error={gateForm.formState.errors.repository?.message} />
                <TextInput label="负责人" {...gateForm.register('owner')} error={gateForm.formState.errors.owner?.message} />
                <TextInput label="依赖" {...gateForm.register('dependency')} error={gateForm.formState.errors.dependency?.message} />
                <TextInput label="版本" {...gateForm.register('version')} error={gateForm.formState.errors.version?.message} />
                <Button type="submit">新增门禁</Button>
              </Group>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <BlockerRow
                key={item.id}
                blocker={item}
                frozen={!!frozen}
                onResolve={() => dispatch(resolveBlocker(item.id))}
                onUpdate={(title, severity) => dispatch(updateBlocker({ blockerId: item.id, title, severity }))}
                onRemove={() => dispatch(removeBlocker(item.id))}
              />
            ))}
            <form onSubmit={blockerForm.handleSubmit((values) => { dispatch(addBlocker(values)); blockerForm.reset(); })}>
              <Group mt="md" align="flex-end">
                <TextInput label="阻断标题" style={{ flex: 1 }} {...blockerForm.register('title')} error={blockerForm.formState.errors.title?.message} />
                <Button type="submit" color={blockerForm.watch('severity') === 'critical' ? 'red' : 'yellow'}>新增{blockerForm.watch('severity') === 'critical' ? '严重' : '警告'}阻断</Button>
              </Group>
            </form>
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布冻结</Title>
            <Text size="sm" c="dimmed" mb="md">冻结前所有阻断关闭且门禁确认；冻结快照连同版本留存，重复回执按对账编号只留一条。</Text>
            <Switch
              label="模拟远端健康检查失败"
              checked={healthFail}
              onChange={(e) => setHealthFail(e.currentTarget.checked)}
              mb="md"
            />
            <Group>
              <Button onClick={startFreeze} disabled={frozen || !!pending?.awaitingHealth}>
                {pending?.awaitingHealth ? '健康检查中…' : '冻结列车'}
              </Button>
              <Button variant="default" onClick={simulateConcurrentFreeze} disabled={frozen}>模拟另一负责人同时冻结</Button>
              <Button color="red" variant="light" onClick={() => dispatch(setFreeze('rolled-back'))} disabled={frozen}>标记回滚</Button>
              <Button variant="default" onClick={() => dispatch(setFreeze('preparing'))} disabled={!frozen}>回到准备</Button>
            </Group>
          </Card>

          {pending && (
            <Card withBorder>
              <Group justify="space-between" mb="xs">
                <Title order={4}>待冻结清单</Title>
                <Badge color="orange">第 {pending.attempts} 次</Badge>
              </Group>
              <Text size="xs" c="dimmed">对账编号 {pending.reconciliationId} · {pending.startedAt}</Text>
              <Text size="sm" mt="xs">待冻结门禁（{pending.gates.length}）：</Text>
              <Stack gap="xs" mt="xs">
                {pending.gates.map((g) => (
                  <Text key={g.gateId} size="sm">{g.repository} · {g.dependency} @ {g.version}</Text>
                ))}
              </Stack>
              {pending.reasons.length > 0 && (
                <Card withBorder mt="sm" p="xs" bg="red.0">
                  <Text size="sm" c="red">未满足原因：</Text>
                  {pending.reasons.map((r, i) => <Text key={i} size="xs" c="red">· {r}</Text>)}
                </Card>
              )}
              {!pending.awaitingHealth && (
                <Button mt="md" onClick={retryFreezeFlow} disabled={checking}>按原对账编号重试</Button>
              )}
            </Card>
          )}

          {receipt && (
            <Card withBorder>
              <Group justify="space-between" mb="xs">
                <Title order={4}>冻结回执</Title>
                <Badge color="blue">已冻结</Badge>
              </Group>
              <Text size="xs" c="dimmed">对账编号 {receipt.reconciliationId} · {receipt.at} · 快照 v{receipt.trainVersion}</Text>
              <Text size="sm" mt="xs">冻结时留存版本：</Text>
              <Stack gap="xs" mt="xs">
                {receipt.gates.map((g) => (
                  <Text key={g.gateId} size="sm">{g.repository} · {g.dependency} @ {g.version}</Text>
                ))}
              </Stack>
              <Text size="sm" mt="xs">冻结时阻断：{receipt.blockers.map((b) => b.title).join('；') || '无'}</Text>
            </Card>
          )}

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={trainForm.handleSubmit((values) => { dispatch(createTrain(values)); trainForm.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...trainForm.register('name')} error={trainForm.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...trainForm.register('freezeAt')} error={trainForm.formState.errors.freezeAt?.message} />
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
            {state.trains.map((item) => (
              <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>
                {item.name} · v{item.version}
              </Button>
            ))}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
