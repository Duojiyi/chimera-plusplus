/** A read-only text preview. User markup is always rendered as escaped React text. */
export function PromptReadingBody({
  content,
  filename,
}: {
  content: string;
  filename: string;
}) {
  return (
    <>
      {content.split(/^```[^\n]*\r?$/m).map((part, index) => {
        if (!part.trim()) return null;
        if (index % 2)
          return (
            <section className="prompt-code-block" key={index}>
              <header>{filename} 源文本</header>
              <pre>{part.trim()}</pre>
            </section>
          );
        return part
          .trim()
          .split(/\r?\n\s*\r?\n/)
          .map((paragraph, line) => {
            const key = `${index}-${line}`;
            const heading = /^#{1,6} ([^\n]+)$/.exec(paragraph);
            return heading ? (
              <h3 key={key}>{heading[1]}</h3>
            ) : (
              <p key={key}>{paragraph}</p>
            );
          });
      })}
    </>
  );
}
