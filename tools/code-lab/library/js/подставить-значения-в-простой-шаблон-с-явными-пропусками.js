function renderTemplate(template, values) {
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Нет значения для шаблона: ${key}`);
    return String(values[key]);
  });
}
console.log(renderTemplate('Привет, {{name}}!', {name:'Анна'}));
