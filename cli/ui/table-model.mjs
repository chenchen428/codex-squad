const collator=new Intl.Collator('zh-CN',{numeric:true});

function columnFor(columns,key){
  if(!Array.isArray(columns)||!key)return null;
  return columns.find(column=>column?.key===key)||null;
}

function comparableValue(column,row){
  const value=typeof column?.value==='function'?column.value(row):undefined;
  if(column?.type==='number'){
    return typeof value==='number'&&Number.isFinite(value)?value:null;
  }
  const text=typeof value==='number'&&Number.isFinite(value)?String(value):typeof value==='string'?value.trim():'';
  return text?text:null;
}

/**
 * 按列定义排序，不修改输入。缺值（null/undefined/非有限数/空文本）在升降序都排在最后；
 * 相等值保持原顺序。sort 为空或列未知时返回原顺序副本。
 * @template T
 * @param {T[]} rows
 * @param {{key: string, direction: 'asc'|'desc'}|null} [sort]
 * @param {{key: string, type: 'number'|'text', value: (row: T) => unknown}[]} [columns]
 * @returns {T[]}
 */
export function sortRows(rows,sort,columns){
  const list=Array.isArray(rows)?rows:[];
  const column=columnFor(columns,sort?.key);
  if(!column)return list.slice();
  const direction=sort?.direction==='desc'?'desc':'asc';
  const sign=direction==='desc'?-1:1;
  const decorated=list.map((row,index)=>({row,index,value:comparableValue(column,row)}));
  decorated.sort((left,right)=>{
    if(left.value===null||right.value===null){
      if(left.value===right.value)return left.index-right.index;
      return left.value===null?1:-1;
    }
    const compared=column.type==='number'
      ?left.value-right.value
      :collator.compare(left.value,right.value);
    return compared===0?left.index-right.index:compared*sign;
  });
  return decorated.map(item=>item.row);
}

/**
 * 新列按类型给出默认方向（数字降序、文本升序），同列再次点击翻转方向。
 * @param {{key: string, direction: 'asc'|'desc'}|null} [current]
 * @param {string} key
 * @param {'number'|'text'} type
 * @returns {{key: string, direction: 'asc'|'desc'}}
 */
export function nextSort(current,key,type){
  if(current&&current.key===key){
    return {key,direction:current.direction==='desc'?'asc':'desc'};
  }
  return {key,direction:type==='number'?'desc':'asc'};
}
