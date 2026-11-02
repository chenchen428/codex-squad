// 共享表格排序模型的行为测试：数值/文本排序、缺失值置末、稳定排序、输入不可变与开关语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSort, sortRows} from '../cli/ui/table-model.mjs';

const NUMBER_COLUMNS = [{key: 'value', type: 'number', value: row => row.value}];
const TEXT_COLUMNS = [{key: 'label', type: 'text', value: row => row.label}];

test('K/M/B 跨量级按原始数字排序，不按格式化标签的字典序', () => {
  const rows = [
    {id: 'b', value: 2_100_000_000},
    {id: 'k', value: 950},
    {id: 'm', value: 3_400_000},
    {id: 'raw', value: 1_200},
  ];
  const asc = sortRows(rows, {key: 'value', direction: 'asc'}, NUMBER_COLUMNS);
  assert.deepEqual(asc.map(row => row.id), ['k', 'raw', 'm', 'b']);
  const desc = sortRows(rows, {key: 'value', direction: 'desc'}, NUMBER_COLUMNS);
  assert.deepEqual(desc.map(row => row.id), ['b', 'm', 'raw', 'k']);
});

test('负数与 0 保留真实符号顺序', () => {
  const rows = [{value: 4}, {value: -2}, {value: 0}, {value: -10}];
  assert.deepEqual(
    sortRows(rows, {key: 'value', direction: 'asc'}, NUMBER_COLUMNS).map(row => row.value),
    [-10, -2, 0, 4],
  );
  assert.deepEqual(
    sortRows(rows, {key: 'value', direction: 'desc'}, NUMBER_COLUMNS).map(row => row.value),
    [4, 0, -2, -10],
  );
});

test('null、undefined、非有限数与空文本在升降序都排在最后', () => {
  const numeric = [
    {id: 'unknown', value: null},
    {id: 'five', value: 5},
    {id: 'missing', value: undefined},
    {id: 'three', value: 3},
    {id: 'nan', value: Number.NaN},
    {id: 'infinite', value: Number.POSITIVE_INFINITY},
  ];
  assert.deepEqual(
    sortRows(numeric, {key: 'value', direction: 'asc'}, NUMBER_COLUMNS).map(row => row.id),
    ['three', 'five', 'unknown', 'missing', 'nan', 'infinite'],
  );
  assert.deepEqual(
    sortRows(numeric, {key: 'value', direction: 'desc'}, NUMBER_COLUMNS).map(row => row.id),
    ['five', 'three', 'unknown', 'missing', 'nan', 'infinite'],
  );

  const textual = [{label: '第10项'}, {label: ''}, {label: '第2项'}, {label: null}];
  assert.deepEqual(
    sortRows(textual, {key: 'label', direction: 'asc'}, TEXT_COLUMNS).map(row => row.label),
    ['第2项', '第10项', '', null],
  );
  assert.deepEqual(
    sortRows(textual, {key: 'label', direction: 'desc'}, TEXT_COLUMNS).map(row => row.label),
    ['第10项', '第2项', '', null],
  );
});

test('文本使用 zh-CN numeric 排序且不区分数字位宽', () => {
  const rows = [{label: '第9章'}, {label: '第10章'}, {label: '第1章'}];
  assert.deepEqual(
    sortRows(rows, {key: 'label', direction: 'asc'}, TEXT_COLUMNS).map(row => row.label),
    ['第1章', '第9章', '第10章'],
  );
});

test('相等值保持原顺序，输入数组与元素不被修改', () => {
  const rows = [{id: 'a', value: 2}, {id: 'b', value: 1}, {id: 'c', value: 2}, {id: 'd', value: 1}];
  const snapshot = structuredClone(rows);
  const sorted = sortRows(rows, {key: 'value', direction: 'asc'}, NUMBER_COLUMNS);
  assert.deepEqual(sorted.map(row => row.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(sortRows(rows, {key: 'value', direction: 'desc'}, NUMBER_COLUMNS).map(row => row.id), ['a', 'c', 'b', 'd']);
  assert.deepEqual(rows, snapshot);
  assert.notEqual(sorted, rows);
});

test('未提供排序或列未知时保留原始顺序副本', () => {
  const rows = [{value: 3}, {value: 1}, {value: 2}];
  assert.deepEqual(sortRows(rows, null, NUMBER_COLUMNS).map(row => row.value), [3, 1, 2]);
  assert.deepEqual(sortRows(rows, {key: 'ghost', direction: 'asc'}, NUMBER_COLUMNS).map(row => row.value), [3, 1, 2]);
  const untouched = sortRows(rows, {key: 'value', direction: 'asc'}, []);
  assert.deepEqual(untouched.map(row => row.value), [3, 1, 2]);
  assert.notEqual(untouched, rows);
});

test('nextSort 新列按类型给默认方向，同列翻转', () => {
  assert.deepEqual(nextSort(null, 'calls', 'number'), {key: 'calls', direction: 'desc'});
  assert.deepEqual(nextSort(null, 'command', 'text'), {key: 'command', direction: 'asc'});
  assert.deepEqual(nextSort({key: 'calls', direction: 'desc'}, 'calls', 'number'), {key: 'calls', direction: 'asc'});
  assert.deepEqual(nextSort({key: 'calls', direction: 'asc'}, 'calls', 'number'), {key: 'calls', direction: 'desc'});
  assert.deepEqual(nextSort({key: 'calls', direction: 'desc'}, 'command', 'text'), {key: 'command', direction: 'asc'});
});
