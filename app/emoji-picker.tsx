import {useState} from "react";
import {X} from "lucide-react";

const groups = [
  {name:"Smileys", entries:[
    ["😀","grinning happy smile"], ["😃","big smile happy"], ["😄","laugh happy smile"], ["😁","beaming grin"], ["😆","squint laugh"], ["😅","nervous laugh sweat"], ["😂","tears of joy lol"], ["🤣","rolling laugh rofl"], ["🙂","slight smile"], ["🙃","upside down sarcasm"], ["😉","wink"], ["😊","blush smile"], ["😇","angel halo"], ["🥰","smile with hearts love"], ["😍","heart eyes love"], ["🤩","star eyes"], ["😘","kiss"], ["😋","delicious yum"], ["😛","tongue"], ["🤪","zany silly"], ["🤫","shush quiet"], ["🤔","thinking hmm"], ["🫡","salute"], ["🤐","zipper mouth secret"], ["😐","neutral"], ["😏","smirk"], ["🙄","eye roll"], ["😬","grimace awkward"], ["😴","sleep"], ["🤯","mind blown"], ["😎","sunglasses cool"], ["🥳","party celebration"], ["🥺","pleading puppy eyes"], ["😭","cry sob"], ["😱","scream shock"], ["😳","flushed embarrassed"], ["😡","angry mad"], ["🤬","swearing"], ["💀","skull dead"], ["👻","ghost spooky"], ["🤖","robot"], ["👀","eyes look"],
  ]},
  {name:"People and hands", entries:[
    ["👍","thumbs up yes like"], ["👍🏽","thumbs up medium skin tone"], ["👎","thumbs down no dislike"], ["👋","wave hello goodbye"], ["🤚","raised hand"], ["✌️","peace victory"], ["🤞","crossed fingers luck"], ["🤟","love you gesture"], ["🤘","rock horns"], ["👌","ok hand"], ["🤌","pinched fingers"], ["👊","fist bump"], ["👏","clap applause"], ["🙌","raised hands celebration"], ["🫶","heart hands love"], ["🤝","handshake agreement"], ["🙏","prayer please thanks high five"], ["💪","strong muscle"], ["👩‍💻","woman technologist developer"], ["👨‍💻","man technologist developer"], ["🧑‍🚀","astronaut space"], ["🤦","facepalm"], ["🤷","shrug"],
  ]},
  {name:"Hearts and symbols", entries:[
    ["❤️","red heart love"], ["🧡","orange heart"], ["💛","yellow heart"], ["💚","green heart"], ["💙","blue heart"], ["💜","purple heart"], ["🖤","black heart"], ["🤍","white heart"], ["💔","broken heart"], ["💕","two hearts"], ["💯","hundred perfect"], ["🔥","fire lit"], ["✨","sparkles"], ["⭐","star"], ["💥","explosion boom"], ["✅","check mark done"], ["❌","cross wrong"], ["⚠️","warning"], ["❓","question mark"], ["💬","chat speech bubble"], ["🎶","music notes"], ["♻️","recycling"], ["🏳️‍🌈","rainbow pride flag"],
  ]},
  {name:"Animals and nature", entries:[
    ["🐶","dog puppy"], ["🐱","cat kitten"], ["🐭","mouse"], ["🐰","rabbit bunny"], ["🦊","fox"], ["🐻","bear"], ["🐼","panda"], ["🐸","frog"], ["🐵","monkey"], ["🦆","duck"], ["🐧","penguin"], ["🦉","owl"], ["🦄","unicorn"], ["🐝","bee"], ["🦋","butterfly"], ["🐢","turtle"], ["🐙","octopus"], ["🐉","dragon"], ["🌵","cactus"], ["🌻","sunflower"], ["🌲","evergreen tree"], ["🌈","rainbow"], ["☀️","sun sunny"], ["🌙","moon night"], ["⚡","lightning"], ["❄️","snowflake"], ["🌊","ocean wave"],
  ]},
  {name:"Food and drink", entries:[
    ["🍎","apple"], ["🍌","banana"], ["🍓","strawberry"], ["🍕","pizza"], ["🍔","burger hamburger"], ["🍟","fries chips"], ["🌮","taco"], ["🍜","ramen noodles"], ["🍣","sushi"], ["🍿","popcorn"], ["🎂","birthday cake"], ["🍰","cake slice"], ["🍪","cookie"], ["🍩","donut doughnut"], ["🍦","ice cream"], ["☕","coffee hot tea"], ["🧋","bubble tea boba"], ["🍻","cheers beer"], ["🥂","cheers champagne"],
  ]},
  {name:"Activities and objects", entries:[
    ["🎉","party popper celebration"], ["🎊","confetti celebration"], ["🎁","gift present"], ["🎈","balloon"], ["🎮","game controller gaming"], ["🎲","dice game"], ["🧩","puzzle"], ["🏆","trophy winner"], ["⚽","soccer football"], ["🏀","basketball"], ["🎯","bullseye target"], ["🎧","headphones"], ["🎤","microphone"], ["📷","camera photo"], ["🎬","clapper movie"], ["💻","laptop computer"], ["💡","bulb idea"], ["📌","pushpin"], ["📚","books study"], ["🛠️","hammer wrench tools"], ["🔧","wrench fix"], ["🚀","rocket launch"], ["🔗","link chain"], ["💤","sleep zzz"],
  ]},
];

export default function EmojiPicker({select,close,label}:{select:(emoji:string)=>void;close:()=>void;label:string}){
  const [query,setQuery]=useState("");
  const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches=groups.map(group=>({...group,entries:group.entries.filter(([emoji,keywords])=>
    terms.every(term=>(emoji+" "+keywords+" "+group.name.toLowerCase()).includes(term)))})).filter(group=>group.entries.length);
  return <div className="chat-picker" role="dialog" aria-label={label} onKeyDown={event=>{
    if(event.key==="Escape"){event.stopPropagation();close();}
  }}>
    <div className="picker-heading">
      <input autoFocus aria-label="Search emoji" placeholder="Search emoji" value={query} onChange={event=>setQuery(event.target.value)}/>
      <button type="button" className="icon-button" aria-label="Close emoji picker" onClick={close}><X size={16}/></button>
    </div>
    <div className="emoji-results">
      {matches.map(group=><section key={group.name}>
        <h3>{group.name}</h3>
        <div className="emoji-grid">{group.entries.map(([emoji,keywords])=>
          <button key={emoji} type="button" aria-label={keywords} title={keywords} onClick={()=>select(emoji)}>{emoji}</button>
        )}</div>
      </section>)}
      {!matches.length&&<p>No matching emoji</p>}
    </div>
  </div>;
}
