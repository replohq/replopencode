export function formatAnswerOutput(input: {
  questions: ReadonlyArray<{ question: string }>
  answers: ReadonlyArray<ReadonlyArray<string>>
}) {
  const formatted = input.questions
    .map((q, i) => `"${q.question}"="${input.answers[i]?.length ? input.answers[i].join(", ") : "Unanswered"}"`)
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}
