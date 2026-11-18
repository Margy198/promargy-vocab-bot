// Страницы учеников в Notion ↔ их chat_id в боте. Список дала Маргарита 18.11.2026.
// Применяется только по кнопке преподавателя «Привязать страницы Notion» (действие notionSeed).
// Привязка не дает и не меняет доступ к боту: это только источник заданий для «Учеба → Мои задания».
export const STUDENT_NOTION_SEED = [
  // у Царя две страницы «Домашнее» — Маргарита указала нужную (18.11), привязана она, а не страница ученика
  { chatId: "187568211", pageId: "1942f2f8690d80d3b6e2c2c2f2afe834", name: "Царь" },
  { chatId: "234335788", pageId: "c9dfd39e1b8e44c4b0a9c1d023e4e31f", name: "Андрей" },
  { chatId: "6939702433", pageId: "1e02f2f8690d80cf9ca3d4903304c687", name: "Алексей (EasyWR)" },
  { chatId: "801979870", pageId: "3072f2f8690d80a5a9b0d4694da24296", name: "Евгений" },
  { chatId: "706825650", pageId: "3732f2f8690d80518468fbed7220bc58", name: "Альберт" },
  { chatId: "546881331", pageId: "3622f2f8690d807480ddea4b47080863", name: "Вадим" },
  { chatId: "1154772352", pageId: "3b52f2f8690d80209831f405367c3b6c", name: "Алекс" },
  { chatId: "173851248", pageId: "3652f2f8690d80159b37d69062e772aa", name: "Анатолий" },
  { chatId: "2017117004", pageId: "10a2f2f8690d8070a38cc6e37c16fc65", name: "Вера" },
  { chatId: "115178261", pageId: "3f22f2f8690d80d7994fc7209485fd78", name: "Maria Kozlova" },
  { chatId: "1028107720", pageId: "4022f2f8690d8037b179f3880a769c1c", name: "Станислав" },
  { chatId: "152840069", pageId: "3902f2f8690d806d91b0c5a160408df5", name: "Mikhail Batin" },
  { chatId: "712505479", pageId: "1f52f2f8690d804d9e1ff8b914a8d06d", name: "Анастасия" },
];
