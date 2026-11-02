# ssh-key-upstream: a private OpenSSH server that ONLY accepts the test
# ed25519 key for user `deploy`. Used by the ssh-key scenario probe to
# prove the gated server authenticated upstream using the bound
# ssh-key account's private key.
#
# The committed id_e2e* keys are test fixtures — never used outside this
# docker harness.
FROM alpine:3.19
RUN apk add --no-cache openssh
RUN ssh-keygen -A
RUN adduser -D -s /bin/sh deploy \
    && passwd -u deploy
COPY id_e2e.pub /home/deploy/.ssh/authorized_keys
RUN chown -R deploy:deploy /home/deploy/.ssh \
    && chmod 700 /home/deploy/.ssh \
    && chmod 600 /home/deploy/.ssh/authorized_keys
# Disable password auth entirely — only the baked authorized_keys may log in.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
