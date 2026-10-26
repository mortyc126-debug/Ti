const таймАут = new Promise((_, reject) => setTimeout(() => reject(new Error("тайм-аут")), 1000));
const результат = await Promise.race([fetch("/api/data"), таймАут]);
