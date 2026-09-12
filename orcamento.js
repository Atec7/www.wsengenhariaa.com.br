document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('indicacaoForm');

    form.addEventListener('submit', (e) => {
        e.preventDefault();

        const yourName = document.getElementById('yourName').value;
        const yourContact = document.getElementById('yourContact').value;
        const clientContact = document.getElementById('clientContact').value;
        const service = document.getElementById('service').value;

        const message = `*SOLICITAÇÃO ORÇAMENTO/COTAÇÃO:*\n
        _(via site)_
         \n *Nome:* ${yourName} \n *Contato:* ${yourContact}\n *Empresa:* ${clientContact} \n *Serviços:* ${service}
        \n\n www.wsengenhariaa.com.br \n        coprygth©2024
        `;
        const whatsappUrl = `https://wa.me/5575991893667?text=${encodeURIComponent(message)}`;

        window.open(whatsappUrl, '_blank');
    });
});