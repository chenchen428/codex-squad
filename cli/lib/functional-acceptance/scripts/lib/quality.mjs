import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const text=value=>typeof value==='string'&&value.trim().length>0;
const placeholder=value=>typeof value==='string'&&/^(?:待填写.*|TODO|TBD|通过|成功|ok|success|符合预期|同预期|未执行|尚未执行|已完成)$/i.test(value.trim());

/** Deterministic publication checks; factual correctness still requires an Agent reading the evidence. */
export function auditQuality(validation) {
 const {data,evidence=new Map()}=validation,errors=[],warnings=[];
 const add=(severity,code,path,message)=>({severity,code,path,message});
 const error=(...args)=>errors.push(add('error',...args)),warn=(...args)=>warnings.push(add('warning',...args));
 if(!validation.ok)return {ok:false,stage:'validate',errors:validation.errors,warnings:validation.warnings||[]};
 const viewer=require('../../assets/studio/app.js');
 const hydrated={...data,evidence:(data.evidence||[]).map(ev=>({...ev,...evidence.get(ev.id)}))};
 const model=viewer.buildModel(hydrated);
 if(!(data.report.links||[]).length)warn('Q_REPORT_LINKS','report.links','Header尚无关联需求或资料链接');
 if(!text(data.report.revision))warn('Q_REVISION','report.revision','报告没有标明所验证的代码或制品版本');
 if(data.report.example)warn('Q_EXAMPLE','report.example','当前是示例，不能交付为真实业务验收');
 let images=0,annotations=0,focusRefs=0,passed=0;
 const repairTasks=[];
 for(const [index,ev]of (data.evidence||[]).entries()){
  const base='evidence['+index+']';
  if(!text(ev.source))warn('Q_EVIDENCE_SOURCE',base+'.source','证据未说明来源及适用环境');
  if(ev.type!=='image')continue;images++;
  const asset=evidence.get(ev.id),list=ev.annotations||[];annotations+=list.length;
  if(!list.length)error('Q_IMAGE_FOCUS',base+'.annotations','图片没有说明验收应关注的区域');
  if(!(asset?.width>0&&asset?.height>0))error('Q_IMAGE_DIMENSIONS',base+'.file','无法读取图片真实尺寸，不能核验标注');
  for(const [i,a]of list.entries()){
   const location=base+'.annotations['+i+']';
   if(asset?.width&&(a.x<0||a.y<0||a.x+a.w>asset.width||a.y+a.h>asset.height))error('Q_IMAGE_BOUNDS',location,'标注超出原图真实边界');
   if(placeholder(a.label))error('Q_IMAGE_LABEL',location+'.label','标注仍是占位或泛化结论');
   if(a.label?.length>24)warn('Q_IMAGE_LABEL_LONG',location+'.label','标签过长，需检查缩放后的可读性及悬停说明');
  }
 }
 for(const [ci,c]of (data.cases||[]).entries()){
  const base='cases['+ci+']',design=c.caseDesign;
  if(!text(design?.why)||placeholder(design?.why))error('Q_CASE_WHY',base+'.caseDesign.why','需要解释为什么设计这个用例，而非只写操作');
  if(!(design?.sources||[]).some(s=>text(s.quote)||text(s.ref)||text(s.url)))error('Q_CASE_SOURCE',base+'.caseDesign.sources','用例缺少需求、既有规则、受影响路径或历史依据');
  if(!c.caseRole||c.caseRole==='unknown')warn('Q_CASE_ROLE',base+'.caseRole','测新、回归或执行审计尚未明确分类');
  if(c.status==='passed'&&(c.steps||[]).some(s=>['failed','blocked','not_run','partial'].includes(s.status)))error('Q_STATUS_CONFLICT',base+'.status','用例通过但仍含失败、阻断、未执行或部分验证步骤');
  for(const [si,s]of (c.steps||[]).entries()){
   const location=base+'.steps['+si+']',v=s.verification||{};
   const refs=[...(s.evidenceIds||[]),...(c.checks||[]).filter(k=>k.stepId===s.id).flatMap(k=>k.evidenceIds||[])];
   const stage=viewer.buildStageModel(s,c,model),missing=[];
   const performed=['passed','failed','partial'].includes(s.status);
   if(performed&&(!text(s.expected)||placeholder(s.expected))){error('Q_EXPECTED',location+'.expected','已执行步骤需要具体预期和判定标准');missing.push('specificExpected');}
   if(performed&&s.type!=='page'){
    if(!text(stage.statement?.text)||stage.statement?.origin!=='executed'){
      error('Q_STEP_ORIGINAL',location+'.verification.statement','已执行步骤必须提供实际查询/调用原文；未留存或重建模板不能作为完整材料');
      missing.push('executedOriginal');
    }
    if(!stage.resultSets.length&&!stage.response){
      error('Q_STEP_RESULT',location+'.verification','缺少能在本步骤展示的原始结果/响应，右栏摘要不能代替执行返回');
      missing.push('visibleRawResult');
    }
   }
   if(v.response&&!stage.response){error('Q_RESPONSE_TARGET',location+'.verification.response','显式响应引用未解析到本步骤原始返回');missing.push('responseTarget');}
   for(const [i,spec]of (v.resultSets||[]).entries())if(!stage.resultSets.some(set=>set.focusIndex===i&&set.evidenceId===spec.evidenceId)){
    error('Q_RESULT_TARGET',location+'.verification.resultSets['+i+']','显式结果集未解析到本步骤真实结果');
    missing.push('resultSetTarget:'+i);
   }
   if(s.status==='passed'){
    passed++;
    if(!text(s.actual)||placeholder(s.actual)){error('Q_ACTUAL',location+'.actual','通过步骤需要具体实际观察，不能用状态或预期代替');missing.push('specificActual');}
    if(!refs.some(id=>evidence.has(id))){error('Q_PASS_EVIDENCE',location+'.evidenceIds','通过步骤没有直接关联证据');missing.push('directEvidence');}
   }
   if(s.type==='page'&&!refs.some(id=>evidence.get(id)?.type==='image')){
    if(performed&&!stage.response){error('Q_PAGE_MATERIAL',location,'已执行页面步骤缺少实拍或可展示的原始浏览器记录');missing.push('originalPageObservation');}
    else warn('Q_PAGE_SCREENSHOT',location,'页面步骤缺少实拍图，不能借其它状态截图替代');
   }
   if(['blocked','partial','not_run'].includes(s.status)&&(!text(s.actual)||placeholder(s.actual))){error('Q_UNKNOWN_REASON',location+'.actual','未验证状态需要说明具体阻断或未执行原因');missing.push('blockingReason');}
   const sets=viewer.buildResultSets(s,model,v)||[];
   for(const [fi,f]of (v.focus||[]).entries())for(const [ri,r]of (f.cellRefs||[]).entries()){
    focusRefs++;const set=sets[r.resultSet];
    if(!set||!Number.isInteger(r.row)||r.row<0||r.row>=set.rows.length||!set.columns.includes(r.column))error('Q_FOCUS_TARGET',location+'.verification.focus['+fi+'].cellRefs['+ri+']','关注点未定位到真实结果表的行与字段');
   }
   if(missing.length)repairTasks.push({caseId:c.id,stepId:s.id,title:s.title,missing,evidenceIds:s.evidenceIds||[],
    sources:(s.evidenceIds||[]).map(id=>{const ev=evidence.get(id);return ev?{id,file:ev.file,source:ev.source,sha256:ev.sha256}:null;}).filter(Boolean),
    actions:['追溯已保存执行工具记录及源文件，核对时间/参数/环境与SHA','把实际原文绑定verification.statement(origin=executed)，保留来源证据','用jsonPointer把真实嵌套结果/响应绑定到本步骤，复跑audit','找不回时保留质量阻断；不得从actual摘要猜SQL或把当前状态充当历史前置']});
  }
  for(const [ki,k]of (c.checks||[]).entries())if(k.status==='passed'){
   const location=base+'.checks['+ki+']';
   if(!text(k.expected)||!text(k.actual)||placeholder(k.actual))error('Q_CHECK_CONTENT',location,'通过核对需要具体预期和实际结果');
   if(!(k.evidenceIds||[]).some(id=>evidence.has(id)))warn('Q_CHECK_EVIDENCE',location+'.evidenceIds','通过核对缺少直接证据，需Agent检查支持关系');
  }
 }
 return {ok:errors.length===0,stage:'quality',inputSha256:validation.inputSha256,errors,warnings,repairTasks,
  stats:{cases:data.cases.length,passedSteps:passed,images,annotations,focusRefs},
  boundary:'规则检查不验证业务结论真实性、来源链接权限或Agent语义审查；每项警告仍需Agent核对并记录缺口。'};
}
