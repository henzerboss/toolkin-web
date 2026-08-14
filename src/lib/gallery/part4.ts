import type { MiniAppSpec } from '../specTypes';

/**
 * Код игр и виджетов вынесен в константы: внутри спеки он превратился бы
 * в нечитаемую строку на пол-экрана, а править его пришлось бы вслепую.
 */
const SNAKE_HTML = `<canvas id="g" width="300" height="300"></canvas>
<div id="hint">Свайп — поворот, тап — старт</div>
<style>
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
  canvas{width:100%;max-width:320px;background:var(--surface);border-radius:var(--radius)}
  #hint{font-size:12px;color:var(--muted)}
</style>
<script>
  var c=document.getElementById('g'),x=c.getContext('2d'),N=15,S=300/N;
  var snake,dir,food,score,alive,tick;
  function reset(){snake=[{x:7,y:7}];dir={x:1,y:0};food=drop();score=0;alive=true;}
  function drop(){return {x:Math.floor(Math.random()*N),y:Math.floor(Math.random()*N)};}
  function draw(){
    var s=getComputedStyle(document.documentElement);
    x.fillStyle=s.getPropertyValue('--surface');x.fillRect(0,0,300,300);
    x.fillStyle=s.getPropertyValue('--accent');
    snake.forEach(function(p){x.fillRect(p.x*S+1,p.y*S+1,S-2,S-2)});
    x.fillStyle=s.getPropertyValue('--text');
    x.fillRect(food.x*S+4,food.y*S+4,S-8,S-8);
    document.getElementById('hint').textContent=alive?('Очки: '+score):('Игра окончена — очки: '+score+'. Тап для новой');
  }
  function step(){
    if(!alive)return;
    var h={x:(snake[0].x+dir.x+N)%N,y:(snake[0].y+dir.y+N)%N};
    if(snake.some(function(p){return p.x===h.x&&p.y===h.y})){
      alive=false;
      toolkin.save({score:score});
      if(score>(toolkin.state.best||0))toolkin.set('best',score);
      draw();return;
    }
    snake.unshift(h);
    if(h.x===food.x&&h.y===food.y){score++;food=drop();}else{snake.pop();}
    draw();
  }
  var sx=0,sy=0;
  c.addEventListener('touchstart',function(e){sx=e.touches[0].clientX;sy=e.touches[0].clientY;});
  c.addEventListener('touchend',function(e){
    var dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)<10&&Math.abs(dy)<10){if(!alive){reset();draw();}return;}
    if(Math.abs(dx)>Math.abs(dy)){if(dir.x===0)dir={x:dx>0?1:-1,y:0};}
    else{if(dir.y===0)dir={x:0,y:dy>0?1:-1};}
  });
  toolkin.onState(function(){});
  reset();draw();tick=setInterval(step,180);
</script>`;

const SKETCH_HTML = `<canvas id="c"></canvas>
<style>body{margin:0}canvas{width:100%;height:100%;display:block;background:var(--surface)}</style>
<script>
  var c=document.getElementById('c'),x=c.getContext('2d'),drawing=false,count=0;
  function fit(){c.width=c.clientWidth*2;c.height=c.clientHeight*2;x.scale(2,2);x.lineCap='round';x.lineJoin='round';}
  function colorOf(name){
    var s=getComputedStyle(document.documentElement);
    return s.getPropertyValue(name==='text'?'--text':name==='muted'?'--muted':'--accent');
  }
  function pos(e){var r=c.getBoundingClientRect();return {x:e.touches[0].clientX-r.left,y:e.touches[0].clientY-r.top};}
  c.addEventListener('touchstart',function(e){
    e.preventDefault();drawing=true;var p=pos(e);
    x.strokeStyle=colorOf(toolkin.state.color);x.lineWidth=toolkin.state.width||4;
    x.beginPath();x.moveTo(p.x,p.y);
  });
  c.addEventListener('touchmove',function(e){
    e.preventDefault();if(!drawing)return;var p=pos(e);x.lineTo(p.x,p.y);x.stroke();
  });
  c.addEventListener('touchend',function(){
    if(!drawing)return;drawing=false;count++;toolkin.set('strokes',count);
  });
  toolkin.onState(function(s){
    // Обнуление счётчика снаружи означает «очистить холст».
    if(s.strokes===0&&count!==0){count=0;x.clearRect(0,0,c.width,c.height);}
  });
  fit();
</script>`;

/**
 * Часть 4: утилиты с ИИ, камерой, генерацией картинок и песочницей.
 * Самые дорогие в работе и самые заметные — ровно то, чего нет у нативных
 * конкурентов из сторов.
 */

export const calorieScanner: MiniAppSpec = {
  schemaVersion: 1, id: 'calorie-scanner', version: 1,
  manifest: { name: 'Калории по фото', icon: 'camera', color: 'amber', locale: 'ru' },
  capabilities: ['camera', 'llm', 'haptics'],
  state: { photo: '', dish: '', kcal: 0, goal: 2000 },
  persist: ['goal'],
  records: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'dish', label: 'Блюдо', kind: 'text' },
    { key: 'kcal', label: 'Ккал', kind: 'number' },
  ], valueField: 'kcal' },
  derived: {
    eaten: 'sum(recordValues)',
    progress: 'clamp(eaten / max(goal, 1), 0, 1)',
    left: 'max(goal - eaten, 0)',
  },
  ui: { type: 'Screen', children: [
    { type: 'Tabs', tabs: [
      { label: 'Сканер', children: [
        { type: 'ProgressRing', progress: 'progress', value: '{{eaten | integer}}',
          label: 'Осталось {{left | integer}} ккал' },
        { type: 'Row', children: [
          { type: 'Button', title: 'Снять', disabled: 'llmBusy', onPress: [
            { action: 'camera.capture', into: 'photo', source: 'camera' },
          ] },
          { type: 'Button', title: 'Из галереи', disabled: 'llmBusy', onPress: [
            { action: 'camera.capture', into: 'photo', source: 'library' },
          ] },
        ] },
        { type: 'Image', source: 'photo', ratio: 'landscape', visible: "photo != ''" },
        { type: 'Text', value: 'Считаю…', variant: 'caption', visible: 'llmBusy' },
        { type: 'Text', value: '{{llmError}}', variant: 'caption', visible: 'llmError != null' },
        { type: 'Button', title: 'Распознать', variant: 'primary', visible: "photo != ''",
          disabled: 'llmBusy', onPress: [
            { action: 'llm.ask', prompt: 'Определи блюдо на фото и его калорийность.', image: 'photo',
              fields: { dish: 'краткое название блюда', kcal: 'калорийность порции числом' } },
          ] },
        { type: 'KeyValue', label: '{{dish}}', value: '{{kcal | integer}} ккал', visible: "dish != ''" },
        { type: 'Button', title: 'Записать в дневник', visible: 'kcal > 0', onPress: [
          { action: 'records.add', values: { photo: '{{photo}}', dish: '{{dish}}', kcal: '{{kcal}}' } },
          { action: 'state.set', key: 'photo', value: '' },
          { action: 'state.set', key: 'dish', value: '' },
          { action: 'state.set', key: 'kcal', value: 0 },
          { action: 'haptics', kind: 'success' },
        ] },
      ] },
      { label: 'Дневник', children: [
        { type: 'Stat', label: 'Съедено за день', value: '{{eaten | integer}} ккал' },
        { type: 'EmptyState', title: 'Записей пока нет', hint: 'Сфотографируйте первое блюдо',
          visible: 'recordCount == 0' },
        { type: 'Gallery', imageKey: 'photo', columns: 3, label: 'Что ели', empty: 'Снимков пока нет' },
        { type: 'List', titleKey: 'dish', subtitleKey: 'kcal', empty: 'Записей пока нет' },
      ] },
      { label: 'Норма', children: [
        { type: 'Section', title: 'Дневная цель', children: [
          { type: 'NumberField', label: 'Норма калорий', bind: 'goal' },
          { type: 'KeyValue', label: 'Съедено', value: '{{eaten | integer}} ккал' },
        ] },
        { type: 'Chart', label: 'Приёмы пищи', values: 'recordValues', empty: 'Данных пока нет' },
      ] },
    ] },
  ] },
};

export const plantIdentifier: MiniAppSpec = {
  schemaVersion: 1, id: 'plant-identifier', version: 1,
  manifest: { name: 'Определитель растений', icon: 'plant', color: 'green', locale: 'ru' },
  capabilities: ['camera', 'llm'],
  state: { photo: '', name: '', care: '', water: '' },
  records: { fields: [
    { key: 'photo', label: 'Фото', kind: 'image' },
    { key: 'name', label: 'Растение', kind: 'text' },
  ], valueField: 'name' },
  ui: { type: 'Screen', children: [
    { type: 'Row', children: [
      { type: 'Button', title: 'Снять', disabled: 'llmBusy', onPress: [
        { action: 'camera.capture', into: 'photo', source: 'camera' },
      ] },
      { type: 'Button', title: 'Из галереи', disabled: 'llmBusy', onPress: [
        { action: 'camera.capture', into: 'photo', source: 'library' },
      ] },
    ] },
    { type: 'Image', source: 'photo', ratio: 'square', visible: "photo != ''",
      empty: 'Сфотографируйте растение' },
    { type: 'Text', value: 'Определяю…', variant: 'caption', visible: 'llmBusy' },
    { type: 'Button', title: 'Определить', variant: 'primary', visible: "photo != ''",
      disabled: 'llmBusy', onPress: [
        { action: 'llm.ask', prompt: 'Определи растение на фото.', image: 'photo',
          fields: {
            name: 'название растения',
            care: 'кратко про уход: свет и температура',
            water: 'как часто поливать',
          } },
      ] },
    { type: 'Stat', label: 'Это', value: '{{name}}', visible: "name != ''" },
    { type: 'KeyValue', label: 'Полив', value: '{{water}}', visible: "water != ''" },
    { type: 'Text', value: '{{care}}', visible: "care != ''" },
    { type: 'Button', title: 'Сохранить в коллекцию', visible: "name != ''", onPress: [
      { action: 'records.add', values: { photo: '{{photo}}', name: '{{name}}' } },
      { action: 'toast', text: 'Добавлено' },
    ] },
    { type: 'Gallery', imageKey: 'photo', columns: 3, label: 'Коллекция', empty: 'Пока пусто' },
  ] },
};

export const recipeGenerator: MiniAppSpec = {
  schemaVersion: 1, id: 'recipe-generator', version: 1,
  manifest: { name: 'Рецепт из остатков', icon: 'chef-hat', color: 'amber', locale: 'ru' },
  capabilities: ['llm', 'image', 'share'],
  state: { products: '', dish: '', imagePrompt: '', ingredients: [], steps: [], picture: '' },
  ui: { type: 'Screen', children: [
    { type: 'TextField', label: 'Что есть в холодильнике', bind: 'products', multiline: true,
      placeholder: 'Курица, картошка, сметана' },
    { type: 'Button', title: 'Придумать рецепт', variant: 'primary',
      disabled: "llmBusy || products == ''", onPress: [
        { action: 'llm.ask', prompt: 'Составь рецепт из продуктов: {{products}}.',
          fields: {
            dish: 'название блюда',
            imagePrompt: 'short English description of the finished dish for an image generator',
            ingredients: 'массив строк: ингредиент и количество',
            steps: 'массив строк: шаги приготовления',
          } },
        { action: 'image.generate', prompt: '{{imagePrompt}}, food photography, appetizing',
          into: 'picture', aspect: 'landscape' },
      ] },
    { type: 'Text', value: 'Готовлю рецепт…', variant: 'caption', visible: 'llmBusy' },
    { type: 'Text', value: '{{llmError}}', variant: 'caption', visible: 'llmError != null' },
    { type: 'Stat', label: 'Блюдо', value: '{{dish}}', visible: "dish != ''" },
    { type: 'Image', source: 'picture', ratio: 'landscape', visible: "picture != ''",
      empty: 'Картинка появится здесь' },
    { type: 'Bullets', label: 'Состав', items: 'ingredients' },
    { type: 'Bullets', label: 'Приготовление', items: 'steps', numbered: true },
    { type: 'Button', title: 'Поделиться рецептом', visible: "dish != ''", onPress: [
      { action: 'share', value: 'Рецепт: {{dish}}' },
    ] },
  ] },
};

export const snakeGame: MiniAppSpec = {
  schemaVersion: 1, id: 'snake-game', version: 1,
  manifest: { name: 'Змейка', icon: 'device-gamepad', color: 'green', locale: 'ru' },
  capabilities: ['sandbox'],
  state: { best: 0 },
  persist: ['best'],
  records: { fields: [{ key: 'score', label: 'Очки', kind: 'number' }], valueField: 'score' },
  derived: { games: 'recordCount' },
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Рекорд', value: '{{best | integer}}', hint: 'Партий: {{games | integer}}' },
    { type: 'Sandbox', ratio: 'square', html: SNAKE_HTML },
    { type: 'Chart', label: 'Последние партии', values: 'recordValues', empty: 'Сыграйте первую партию' },
  ] },
};

export const sketchpad: MiniAppSpec = {
  schemaVersion: 1, id: 'sketchpad', version: 1,
  manifest: { name: 'Скетчбук', icon: 'brush', color: 'violet', locale: 'ru' },
  capabilities: ['sandbox'],
  state: { strokes: 0, color: 'accent', width: 4 },
  persist: ['color', 'width'],
  ui: { type: 'Screen', children: [
    { type: 'Stat', label: 'Штрихов', value: '{{strokes | integer}}' },
    { type: 'Sandbox', height: 320, html: SKETCH_HTML },
    { type: 'Select', label: 'Цвет', bind: 'color', options: [
      { value: 'accent', label: 'Акцент' },
      { value: 'text', label: 'Тёмный' },
      { value: 'muted', label: 'Серый' },
    ] },
    { type: 'Slider', label: 'Толщина', bind: 'width', min: 1, max: 20, step: 1, readout: '{{width}}' },
    { type: 'Button', title: 'Очистить', onPress: [{ action: 'state.set', key: 'strokes', value: 0 }] },
  ] },
};
