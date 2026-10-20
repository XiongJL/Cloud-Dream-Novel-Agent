import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentSkillSlashMenu} from '../src/components/AgentWorkspace/AgentSkillSlashMenu';
import {SelectedSkillChips} from '../src/components/AgentWorkspace/SelectedSkillChips';
import {selectedAgentSkills, selectAgentSkillMode, removeSelectedAgentSkill, agentSkillEntryHint,
  type AgentSkillComposerMode, type AgentSkillMenuSkill} from '../shared/agentSkillComposer';

const skills: AgentSkillMenuSkill[] = ['语言风格', '悬念释放', '群像推进', '角色对白与不同情境下的叙述距离变化'].map((title,index) => ({
  id:`skill-${index}`, stableId:`style.skill-${index}`, title, description:'按场景目标应用独立方法', scope:'user',
  version:'1.0.1', revisionId:`locked-${index}`, enabled:true, supportedOperations:['chapter.continuation'], allowedRoles:['writer'],
}));
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
document.body.style.background = dark ? '#17181a' : '#fff';
document.body.style.color = dark ? '#eee' : '#222';

function Fixture() {
  const [mode,setMode] = useState<AgentSkillComposerMode>();
  const [menu,setMenu] = useState(true);
  const [text,setText] = useState('续写下一章');
  const selected = selectedAgentSkills(mode);
  return <main style={{maxWidth:700,margin:'24px auto',padding:16}}><h1>Skill 多选交互</h1><p>隔离测试，不会调用模型</p>
    <div style={{position:'relative',marginTop:390,border:'1px solid #888',borderRadius:12,padding:12}}>
      {menu && <AgentSkillSlashMenu skills={skills} selectedSkillIds={selected.map(skill => skill.id)} query="" activeItem={undefined}
        isDark={dark} loading={false} error="" onRetry={()=>{}} onSelect={item=>{setMode(current=>selectAgentSkillMode(current,item));setMenu(false);}} />}
      {selected.length > 0 && <SelectedSkillChips skills={selected} isDark={dark} onRemove={id=>setMode(current=>removeSelectedAgentSkill(current,id))} onAdd={()=>setMenu(true)} />}
      {selected.length === 0 && <button type="button" onClick={()=>setMenu(true)}>选择 Skill</button>}
      <textarea aria-label="任务正文" value={text} onChange={event=>setText(event.target.value)} style={{display:'block',width:'100%',minHeight:80,background:'transparent'}} />
      <button type="button" onClick={()=>setMode(current=>removeSelectedAgentSkill(current,'skill-1'))}>模拟删除悬念 Skill</button>
    </div>
    <pre aria-label="本次请求" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(agentSkillEntryHint(mode),null,2)}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
