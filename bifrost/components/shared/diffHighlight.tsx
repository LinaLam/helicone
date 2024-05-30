import React from "react";
import { Highlight, Token, themes } from "prism-react-renderer";
import { ClipboardIcon } from "@heroicons/react/24/outline";

interface DiffHighlightProps {
  code: string;
  language: string;
}

export function DiffHighlight(props: DiffHighlightProps) {
  const { code, language } = props;

  const hasBaseURL = (tokens: Token[]) => {
    return tokens.some((token) =>
      token.content.includes("https://oai.hconeai.com/v1")
    );
  };

  return (
    <div className="ph-no-capture w-full overflow-auto rounded-b-2xl">
      <Highlight theme={themes.jettwaveDark} code={code} language={"tsx"}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre style={style} className="p-6 leading-7 max-h-96 overflow-auto">
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="text-gray-500 pr-4">{i + 1}</span>
                {line.map((token, key) => {
                  if (
                    token.content.includes("https://oai.hconeai.com") ||
                    token.content.includes("https://anthropic.hconeai.com")
                  ) {
                    return (
                      <span
                        key={key}
                        className={
                          "text-sky-400 underline underline-offset-4 decoration-dashed"
                        }
                      >
                        {token.content}
                      </span>
                    );
                  } else {
                    return <span key={key} {...getTokenProps({ token })} />;
                  }
                })}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
