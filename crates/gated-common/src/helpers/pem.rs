/// Repairs a pasted PEM block whose line breaks were lost or mangled
/// (joined with spaces, put on one line, indented, CR-only or literal `\n`)
/// by re-wrapping the base64 body between the BEGIN and END lines. Input
/// without a BEGIN/END pair is returned unchanged; a block with RFC 1421
/// headers (`Proc-Type:`) only gets its line endings and indentation
/// normalized.
pub fn normalize_pem(input: &str) -> String {
    let text = input
        .replace("\\n", "\n")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let trimmed_lines = || {
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        format!("{}\n", lines.join("\n").trim())
    };
    let Some(begin) = text.find("-----BEGIN ") else {
        return input.to_owned();
    };
    let label_start = begin + "-----BEGIN ".len();
    let Some(label_len) = text[label_start..].find("-----") else {
        return input.to_owned();
    };
    let label = &text[label_start..label_start + label_len];
    let body_start = label_start + label_len + "-----".len();
    let footer = format!("-----END {label}-----");
    let Some(body_len) = text[body_start..].find(&footer) else {
        return input.to_owned();
    };
    let body = &text[body_start..body_start + body_len];
    if body.contains(':') {
        return trimmed_lines();
    }
    let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let width = if label == "OPENSSH PRIVATE KEY" {
        70
    } else {
        64
    };
    let mut out = format!("-----BEGIN {label}-----\n");
    let mut rest = body.as_str();
    while !rest.is_empty() {
        let (line, tail) = rest.split_at(width.min(rest.len()));
        out.push_str(line);
        out.push('\n');
        rest = tail;
    }
    out.push_str(&footer);
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::normalize_pem;

    fn canonical(label: &str, width: usize) -> (String, Vec<String>) {
        let body: String = "AbCdEfGh0123456789+/".repeat(10);
        let lines: Vec<String> = body
            .as_bytes()
            .chunks(width)
            .map(|chunk| String::from_utf8(chunk.to_vec()).expect("ascii"))
            .collect();
        let mut pem = format!("-----BEGIN {label}-----\n");
        for line in &lines {
            pem.push_str(line);
            pem.push('\n');
        }
        pem.push_str(&format!("-----END {label}-----\n"));
        let mut all = vec![format!("-----BEGIN {label}-----")];
        all.extend(lines);
        all.push(format!("-----END {label}-----"));
        (pem, all)
    }

    #[test]
    fn rewraps_mangled_line_breaks() {
        for (label, width) in [("OPENSSH PRIVATE KEY", 70), ("PRIVATE KEY", 64)] {
            let (pem, lines) = canonical(label, width);
            let indented: Vec<String> = lines.iter().map(|line| format!("  {line}")).collect();
            for mangled in [
                pem.clone(),
                pem.replace('\n', "\r\n"),
                pem.replace('\n', "\r"),
                pem.trim_end().to_owned(),
                lines.join(" "),
                lines.join(""),
                lines.join("\\n"),
                lines.join("\n\n"),
                indented.join("\n"),
                format!("\n  {}  \n", lines.join(" ")),
            ] {
                assert_eq!(normalize_pem(&mangled), pem, "{mangled:?}");
            }
        }
    }

    #[test]
    fn leaves_text_without_a_pem_block_unchanged() {
        assert_eq!(normalize_pem("KEY"), "KEY");
        assert_eq!(
            normalize_pem("-----BEGIN X-----\nAAAA"),
            "-----BEGIN X-----\nAAAA"
        );
    }

    #[test]
    fn keeps_rfc1421_headers_on_their_own_lines() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";
        assert_eq!(normalize_pem(&pem.replace('\n', "\r\n")), pem);
    }
}
