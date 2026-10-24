FROM alpine:3.19
RUN apk add --no-cache openssh
RUN ssh-keygen -A
RUN adduser -D -s /bin/sh deploy \
    && echo "deploy:deploypass" | chpasswd \
    && echo "root:rootpass" | chpasswd
RUN sed -i 's/^#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
