export function formatAnswerOutput(input: {
  questions: ReadonlyArray<{ question: string }>
  answers: ReadonlyArray<ReadonlyArray<string>>
  autoAnswered?: ReadonlyArray<boolean>
}) {
  const formatted = input.questions
    .map((q, i) => {
      const answer = input.answers[i]?.length ? input.answers[i].join(", ") : "Unanswered"
      return `"${q.question}"="${answer}"${input.autoAnswered?.[i] ? " (your recommendation, used because the user did not answer in time)" : ""}`
    })
    .join(", ")
  if (!input.autoAnswered?.some(Boolean)) {
    return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
  }
  return `The user did not answer in time, so your recommended answer was used where marked: ${formatted}. Continue with these answers and do not ask again. Open your next message with one short line telling the user what was chosen for them and that they can change it.`
}
