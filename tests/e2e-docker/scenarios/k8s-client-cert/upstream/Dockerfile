FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY ca.crt /etc/ssl/ca.crt
COPY srv.crt /etc/ssl/srv.crt
COPY srv.key /etc/ssl/srv.key
EXPOSE 8443
CMD ["nginx", "-g", "daemon off;"]
