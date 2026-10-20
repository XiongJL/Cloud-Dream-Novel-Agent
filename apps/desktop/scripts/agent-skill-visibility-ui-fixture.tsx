// Local browser fixture: renders the production components against an in-memory bridge.
// No database, model, or production IPC is called.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentSkillSlashMenu} from '../src/components/AgentWorkspace/AgentSkillSlashMenu';
import {SkillVisibilityDialog, type SkillVisibilityTarget} from '../src/components/AgentWorkspace/SkillVisibilityDialog';
import {SkillDeleteDialog} from '../src/components/AgentWorkspace/SkillDeleteDialog';

let scope = 'novel', owner: string | null = 'a', visibilityVersion = 1;
const calls: string[] = [];
const deleted = new Set<string>();
let failDelete = false, activeUse = false;
(window as any).deleteFixture = {setFailure: (value: boolean) => {failDelete=value;}, setActive: (value: boolean) => {activeUse=value;}};
const members = [{memberKey:'language',title:'语言',slot:'core',skillId:'language',revisionId:'language-v1'},{memberKey:'suspense',title:'悬念',slot:'auxiliary',skillId:'suspense',revisionId:'suspense-v1'}];
const preview = (p: any) => ({targetId:p.targetId,targetType:p.targetType,title:'测试文风包',scope,ownerNovelId:owner,visibilityVersion,
  requestedScope:p.scope || scope,requestedOwnerNovelId:p.scope==='user'?null:p.ownerNovelId || owner,
  previewToken:`${visibilityVersion}:${p.scope || scope}:${p.ownerNovelId || owner}`,
  unchanged:(p.scope || scope)===scope && (p.scope==='user'?null:p.ownerNovelId || owner)===owner,
  novels:[{id:'a',title:'小说 A'},{id:'b',title:'小说 B'}],managedBy:[],sharedMembers:[],members,
  affectedDefaults:p.scope==='novel'&&scope==='user'?[{novelId:'b',title:'小说 B'}]:[],affectedBindingCount:0});
(window as any).agent = {
  skillVisibility:async (p:any)=>{calls.push('preview');return preview(p);},
  skillPack:async ()=>({members}),
  setSkillVisibility:async (p:any)=>{calls.push('set');if(p.expectedVisibilityVersion!==visibilityVersion)throw Error('范围已变更，请重新加载。');scope=p.scope;owner=scope==='user'?null:p.ownerNovelId;visibilityVersion++;return {...preview(p),scope,ownerNovelId:owner};},
};
(window as any).automation = {invoke:async (method:string,p:any)=>{
  if (method==='agent_skill.delete.preview') return {targetType:p.targetType,targetId:p.targetId,title:p.targetId,scope:p.targetType==='pack'?scope:'user',visibilityVersion:1,previewToken:'checked',
    canDelete:!activeUse&&(p.targetId!=='language'||deleted.has('pack')),managedBy:p.targetId==='language'&&!deleted.has('pack')?[{id:'pack',title:'测试文风包'}]:[],
    activeUseCount:activeUse?1:0,affectedDefaults:p.targetType==='pack'?[{novelId:'b',title:'小说 B'}]:[],affectedBindingCount:0,retainedMemberCount:p.targetType==='pack'?2:0};
  if (method==='agent_skill.delete') {calls.push('delete');if(failDelete)throw Error('关联已变化，请重新预览后删除。');deleted.add(p.targetId);return {targetType:p.targetType,targetId:p.targetId,deleted:true};}
  return {title:p.skillId==='language'?'语言':'悬念',revision:{instructions:'用具体动作与对白推进场景。'}};
}};

function Fixture() {
  const [tick,setTick]=useState(0),[target,setTarget]=useState<SkillVisibilityTarget|null>(null),[selection,setSelection]=useState(0);
  const [deleteTarget,setDeleteTarget]=useState<SkillVisibilityTarget|null>(null);
  const pack:any={id:'pack',stableId:'pack',title:'测试文风包',description:'语言与悬念方法',scope,ownerNovelId:owner,version:'1.0.0',revisionId:'pack-v1',enabled:true,entryType:'pack',available:true,members};
  return <main style={{maxWidth:700,margin:'30px auto',padding:20}}><h1>Skill 范围交互测试</h1><p>隔离桥接器 · 当前小说 A · 使用次数：<span id="selections">{selection}</span></p>
    <div style={{position:'relative',marginTop:410,border:'1px solid #ccc',padding:14}}>
      <AgentSkillSlashMenu packs={!deleted.has('pack')&&(scope==='user'||owner==='a')?[pack]:[]} skills={[
        ...(!deleted.has('language')?[{id:'language',title:'语言成员',description:'包内语言方法',scope:'user',version:'1.0.0',enabled:true} as any]:[]),
        {id:'builtin',title:'内置方法',description:'应用内置',scope:'builtin',version:'1.0.0',enabled:true} as any]} query="" activeItem={undefined} isDark={false} loading={false} error="" onRetry={()=>{}}
        onSelect={()=>setSelection(n=>n+1)} onManage={(item,view)=>{const entry:SkillVisibilityTarget={targetType:'entryType' in item?'pack':'skill',targetId:item.id,title:item.title,builtin:item.scope==='builtin'};if(view==='delete')setDeleteTarget(entry);else setTarget({...entry,initialView:view});}}/>
      <textarea aria-label="输入任务" defaultValue="/" />
    </div>
    <p id="scope-result">当前范围：{scope==='user'?'所有小说':`小说 ${owner?.toUpperCase()}`}</p>
    <p id="calls">桥接调用：{calls.join(',')} · {tick}</p>
    {target&&<SkillVisibilityDialog target={target} novelId="a" isDark={false} onClose={()=>setTarget(null)} onChanged={async()=>setTick(n=>n+1)} onDelete={entry=>{setTarget(null);setDeleteTarget(entry);}}/>}
    {deleteTarget&&<SkillDeleteDialog target={deleteTarget} isDark={false} onClose={()=>setDeleteTarget(null)} onDeleted={async()=>setTick(n=>n+1)}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
